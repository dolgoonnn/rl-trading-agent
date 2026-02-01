#!/usr/bin/env npx tsx
/**
 * Comprehensive Batch Ingestion Script for ICT Knowledge Base
 *
 * Handles full pipeline:
 * 1. Extract transcripts from YouTube
 * 2. Process into concept markdown files
 * 3. Chunk knowledge content
 * 4. Ingest into SQLite database
 * 5. Generate embeddings for semantic search
 *
 * Usage:
 *   # Process all videos from playlist with embeddings
 *   npx tsx scripts/batch-ingest-all.ts --playlist 2022-mentorship --embed
 *
 *   # Process with limit (testing)
 *   npx tsx scripts/batch-ingest-all.ts --playlist if-i-could-go-back --limit 1 --embed
 *
 *   # Skip transcript extraction (use existing)
 *   npx tsx scripts/batch-ingest-all.ts --playlist market-maker-series --skip-transcript --embed
 */

import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { eq, isNull } from 'drizzle-orm';

// Import from knowledge base modules
import { getTranscript, type TranscriptResult } from '../src/lib/kb/ingest/youtube';
import { processTranscript } from '../src/lib/kb/process/structurer';
import { generateConceptMarkdown } from '../src/lib/kb/ingest/markdown';
import { createVideoChunks, mergeSmallChunks } from '../src/lib/kb/process/chunker';
import { embedChunks, checkOllamaStatus } from '../src/lib/kb/process/embedder';
import type { KnowledgeChunk } from '../src/lib/kb/types';

// Import database
import { db } from '../src/lib/data/db';
import { knowledgeChunks, videoSources } from '../src/lib/data/schema';

interface VideoInfo {
  id: string;
  title: string;
}

interface PlaylistData {
  name: string;
  playlistUrl: string;
  videoCount: number;
  phase: string;
  focus: string;
  videos: VideoInfo[];
}

interface VideoListJson {
  playlists: Record<string, PlaylistData>;
}

interface BatchProcessingConfig {
  playlist: string;
  limit?: number;
  resume?: boolean;
  embed?: boolean;
  skipTranscript?: boolean;
  skipProcessing?: boolean;
}

interface ProcessingResult {
  stage: 'extract' | 'process' | 'chunk' | 'ingest' | 'embed';
  playlist: string;
  successful: number;
  failed: number;
  total: number;
  duration: number;
  errors: Array<{ videoId: string; error: string }>;
}

// ============================================================================
// MAIN PIPELINE
// ============================================================================

async function runBatchIngestion(config: BatchProcessingConfig) {
  const startTime = Date.now();

  console.log('\n🎬 ICT Knowledge Base - Batch Ingestion Pipeline');
  console.log('═'.repeat(60));
  console.log(`📊 Configuration:`);
  console.log(`   Playlist: ${config.playlist}`);
  if (config.limit) console.log(`   Limit: ${config.limit} videos`);
  if (config.resume) console.log(`   Mode: Resume from last checkpoint`);
  if (config.embed) console.log(`   Pipeline: Extract → Process → Chunk → Ingest → Embed`);
  else console.log(`   Pipeline: Extract → Process → Chunk → Ingest`);
  console.log('─'.repeat(60));

  // Load video list
  const videoList = await loadVideoList();
  const playlistData = videoList.playlists[config.playlist];

  if (!playlistData) {
    console.error(`❌ Playlist "${config.playlist}" not found!`);
    console.error('\nAvailable playlists:');
    Object.keys(videoList.playlists).forEach((key) => {
      console.error(`  - ${key}`);
    });
    process.exit(1);
  }

  let videos = playlistData.videos;
  if (config.limit) {
    videos = videos.slice(0, config.limit);
  }

  console.log(`\n📺 Processing ${videos.length} videos from "${playlistData.name}"`);

  const results: ProcessingResult[] = [];

  try {
    // Stage 1: Extract transcripts
    if (!config.skipTranscript) {
      console.log('\n📥 Stage 1: Extracting Transcripts');
      console.log('─'.repeat(60));
      const extractResult = await extractTranscripts(videos, playlistData.name, config);
      results.push(extractResult);

      if (extractResult.failed > 0) {
        console.log(
          `\n⚠️  ${extractResult.failed} transcripts failed to extract. Review errors above.`
        );
      }
    }

    // Stage 2: Process transcripts into concepts
    if (!config.skipProcessing) {
      console.log('\n🔄 Stage 2: Processing Concepts');
      console.log('─'.repeat(60));
      const processResult = await processTranscriptsToMarkdown(videos, playlistData.name, config);
      results.push(processResult);

      if (processResult.failed > 0) {
        console.log(`\n⚠️  ${processResult.failed} concepts failed to process.`);
      }
    }

    // Stage 3: Chunk knowledge content
    console.log('\n✂️  Stage 3: Chunking Knowledge');
    console.log('─'.repeat(60));
    const chunkResult = await chunkKnowledge(videos, playlistData.name, config);
    results.push(chunkResult);

    // Stage 4: Ingest into database
    console.log('\n💾 Stage 4: Ingesting into Database');
    console.log('─'.repeat(60));
    const ingestResult = await ingestDatabase(videos, playlistData.name, config);
    results.push(ingestResult);

    // Stage 5: Generate embeddings (optional)
    if (config.embed) {
      console.log('\n🧠 Stage 5: Generating Embeddings');
      console.log('─'.repeat(60));
      const embedResult = await generateEmbeddings(config);
      results.push(embedResult);
    }

    // Final summary
    await printSummary(results, startTime);
  } catch (error) {
    console.error('\n❌ Batch ingestion failed:', error);
    process.exit(1);
  }
}

// ============================================================================
// STAGE 1: EXTRACT TRANSCRIPTS
// ============================================================================

async function extractTranscripts(
  videos: VideoInfo[],
  playlistName: string,
  config: BatchProcessingConfig
): Promise<ProcessingResult> {
  const stageStart = Date.now();
  const errors: Array<{ videoId: string; error: string }> = [];
  let successful = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  // Rate limiting settings - Using Tor, can be more aggressive
  const BASE_DELAY_MS = 3000; // 3 seconds between requests (Tor rotates IPs)
  const BACKOFF_DELAY_MS = 10000; // 10 seconds after failure
  const MAX_BACKOFF_MS = 60000; // Max 1 minute backoff
  const RATE_LIMIT_PAUSE_MS = 30000; // 30 second pause on rate limit (Tor gets new circuit)

  // Ensure output directory exists
  const outputDir = join(process.cwd(), 'knowledge-base', 'sources', 'youtube', config.playlist);
  await mkdir(outputDir, { recursive: true });

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    if (!video) continue;

    const outputPath = join(outputDir, `${video.id}.json`);

    // Skip if already exists (always skip existing to avoid re-downloading)
    if (existsSync(outputPath)) {
      console.log(`   [${i + 1}/${videos.length}] ⏭️  ${video.title.slice(0, 40)}... (exists)`);
      successful++;
      continue;
    }

    // Rate limiting: add delay between requests
    if (i > 0) {
      const delay = consecutiveFailures > 0
        ? Math.min(BACKOFF_DELAY_MS * consecutiveFailures, MAX_BACKOFF_MS)
        : BASE_DELAY_MS;
      console.log(`   ⏳ Waiting ${delay / 1000}s to avoid rate limiting...`);
      await sleep(delay);
    }

    console.log(`   [${i + 1}/${videos.length}] 📥 ${video.title.slice(0, 50)}...`);

    try {
      // Use Tor proxy to bypass YouTube rate limiting
      const transcript = await getTranscript(video.id, { grouped: true, useTor: true });

      if (transcript.error) {
        // Check if it's a rate limit error
        if (transcript.error.includes('429') || transcript.error.includes('Too Many Requests') || transcript.error.includes('blocking') || transcript.error.includes('Could not retrieve')) {
          // Retry up to 3 times with increasing delays
          let retrySuccess = false;
          for (let retry = 1; retry <= 3; retry++) {
            const retryDelay = RATE_LIMIT_PAUSE_MS * retry; // 5min, 10min, 15min
            console.log(`              ⚠️  Rate limited! Pausing for ${retryDelay / 1000}s (retry ${retry}/3)...`);
            await sleep(retryDelay);

            console.log(`              🔄 Retrying...`);
            const retryTranscript = await getTranscript(video.id, { grouped: true });

            if (!retryTranscript.error) {
              // Success on retry
              await writeFile(
                outputPath,
                JSON.stringify(
                  {
                    ...retryTranscript,
                    title: video.title,
                    playlistName,
                    extractedAt: new Date().toISOString(),
                  },
                  null,
                  2
                )
              );
              await upsertVideoSource(video.id, video.title, config.playlist, playlistName, 'transcribed');
              successful++;
              consecutiveFailures = 0;
              console.log(`              ✅ Saved on retry ${retry} (${retryTranscript.segments?.length ?? 0} segments)`);
              retrySuccess = true;
              break;
            }
          }

          if (!retrySuccess) {
            consecutiveFailures++;
            throw new Error(transcript.error);
          }
          continue;
        }
        throw new Error(transcript.error);
      }

      // Save transcript
      await writeFile(
        outputPath,
        JSON.stringify(
          {
            ...transcript,
            title: video.title,
            playlistName,
            extractedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );

      // Update video source in database
      await upsertVideoSource(video.id, video.title, config.playlist, playlistName, 'transcribed');

      successful++;
      consecutiveFailures = 0; // Reset on success
      console.log(`              ✅ Saved (${transcript.segments?.length ?? 0} segments)`);
    } catch (error) {
      failed++;
      consecutiveFailures++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({ videoId: video.id, error: errorMsg });
      console.log(`              ❌ Failed: ${errorMsg.slice(0, 50)}`);

      // Update video source with error
      await upsertVideoSource(
        video.id,
        video.title,
        config.playlist,
        playlistName,
        'error',
        errorMsg
      );

      // If too many consecutive failures, increase wait time significantly
      if (consecutiveFailures >= 3) {
        console.log(`   ⚠️  Multiple failures detected. Pausing for ${RATE_LIMIT_PAUSE_MS / 1000}s...`);
        await sleep(RATE_LIMIT_PAUSE_MS);
      }
    }
  }

  return {
    stage: 'extract',
    playlist: config.playlist,
    successful,
    failed,
    total: videos.length,
    duration: Date.now() - stageStart,
    errors,
  };
}

// ============================================================================
// STAGE 2: PROCESS TRANSCRIPTS TO MARKDOWN
// ============================================================================

async function processTranscriptsToMarkdown(
  videos: VideoInfo[],
  playlistName: string,
  config: BatchProcessingConfig
): Promise<ProcessingResult> {
  const stageStart = Date.now();
  const errors: Array<{ videoId: string; error: string }> = [];
  let successful = 0;
  let failed = 0;

  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('   ⚠️  ANTHROPIC_API_KEY not set - skipping LLM processing');
    console.log('   💡 Add your key to .env.local to enable concept extraction');
    return {
      stage: 'process',
      playlist: config.playlist,
      successful: 0,
      failed: 0,
      total: videos.length,
      duration: Date.now() - stageStart,
      errors: [{ videoId: 'all', error: 'ANTHROPIC_API_KEY not set' }],
    };
  }

  const transcriptDir = join(
    process.cwd(),
    'knowledge-base',
    'sources',
    'youtube',
    config.playlist
  );
  const conceptsDir = join(process.cwd(), 'knowledge-base', 'concepts');

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    if (!video) continue;

    const transcriptPath = join(transcriptDir, `${video.id}.json`);

    // Skip if transcript doesn't exist
    if (!existsSync(transcriptPath)) {
      console.log(`   [${i + 1}/${videos.length}] ⏭️  ${video.title.slice(0, 40)}... (no transcript)`);
      continue;
    }

    console.log(`   [${i + 1}/${videos.length}] 🔄 ${video.title.slice(0, 50)}...`);

    try {
      // Load transcript
      const transcriptData = JSON.parse(await readFile(transcriptPath, 'utf-8')) as TranscriptResult & {
        title?: string;
      };

      // Process with LLM
      const result = await processTranscript(
        transcriptData.groupedSegments ?? transcriptData.fullText ?? '',
        video.id,
        video.title,
        playlistName
      );

      // Save each concept as markdown
      for (const concept of result.concepts) {
        const categoryDir = join(conceptsDir, concept.frontmatter.category);
        await mkdir(categoryDir, { recursive: true });

        const markdown = generateConceptMarkdown(concept);
        const outputPath = join(categoryDir, `${concept.frontmatter.slug}.md`);

        // Append if file exists (multiple videos may cover same concept)
        if (existsSync(outputPath)) {
          // Just log it - don't overwrite, keep the first extraction
          console.log(`              📝 Concept exists: ${concept.frontmatter.slug}`);
        } else {
          await writeFile(outputPath, markdown);
          console.log(`              ✅ Created: ${concept.frontmatter.slug}`);
        }
      }

      // Update video source status
      await upsertVideoSource(video.id, video.title, config.playlist, playlistName, 'processed');

      successful++;
      console.log(`              ✅ Extracted ${result.concepts.length} concepts`);
    } catch (error) {
      failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({ videoId: video.id, error: errorMsg });
      console.log(`              ❌ Failed: ${errorMsg.slice(0, 50)}`);
    }

    // Rate limit for Claude API
    await sleep(1000);
  }

  return {
    stage: 'process',
    playlist: config.playlist,
    successful,
    failed,
    total: videos.length,
    duration: Date.now() - stageStart,
    errors,
  };
}

// ============================================================================
// STAGE 3: CHUNK KNOWLEDGE
// ============================================================================

async function chunkKnowledge(
  videos: VideoInfo[],
  _playlistName: string,
  config: BatchProcessingConfig
): Promise<ProcessingResult> {
  const stageStart = Date.now();
  const errors: Array<{ videoId: string; error: string }> = [];
  let successful = 0;
  let failed = 0;

  // We'll chunk from transcripts directly (doesn't require LLM)
  const transcriptDir = join(
    process.cwd(),
    'knowledge-base',
    'sources',
    'youtube',
    config.playlist
  );
  const chunksDir = join(process.cwd(), 'knowledge-base', 'chunks', config.playlist);
  await mkdir(chunksDir, { recursive: true });

  const allChunks: KnowledgeChunk[] = [];

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    if (!video) continue;

    const transcriptPath = join(transcriptDir, `${video.id}.json`);

    if (!existsSync(transcriptPath)) {
      console.log(`   [${i + 1}/${videos.length}] ⏭️  ${video.title.slice(0, 40)}... (no transcript)`);
      continue;
    }

    console.log(`   [${i + 1}/${videos.length}] ✂️  ${video.title.slice(0, 50)}...`);

    try {
      // Load transcript
      const transcriptData = JSON.parse(await readFile(transcriptPath, 'utf-8')) as TranscriptResult & {
        title?: string;
        playlistName?: string;
      };

      // Create chunks from transcript text
      // Build a simple markdown structure from transcript
      const transcriptMarkdown = buildTranscriptMarkdown(transcriptData, video.title);

      const chunks = createVideoChunks(
        transcriptMarkdown,
        video.id,
        `https://www.youtube.com/watch?v=${video.id}`,
        { maxTokens: 512, overlap: 50 }
      );

      // Merge small chunks
      const mergedChunks = mergeSmallChunks(chunks, 100);

      // Add playlist info to chunks
      for (const chunk of mergedChunks) {
        chunk.concept = config.playlist;
        allChunks.push(chunk);
      }

      // Save chunks as JSON for reference
      const chunksPath = join(chunksDir, `${video.id}-chunks.json`);
      await writeFile(chunksPath, JSON.stringify(mergedChunks, null, 2));

      successful++;
      console.log(`              ✅ Created ${mergedChunks.length} chunks`);
    } catch (error) {
      failed++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({ videoId: video.id, error: errorMsg });
      console.log(`              ❌ Failed: ${errorMsg.slice(0, 50)}`);
    }
  }

  // Save all chunks to a combined file
  const allChunksPath = join(chunksDir, `_all-chunks.json`);
  await writeFile(allChunksPath, JSON.stringify(allChunks, null, 2));
  console.log(`\n   📦 Total chunks: ${allChunks.length} saved to ${allChunksPath}`);

  return {
    stage: 'chunk',
    playlist: config.playlist,
    successful,
    failed,
    total: videos.length,
    duration: Date.now() - stageStart,
    errors,
  };
}

// ============================================================================
// STAGE 4: INGEST INTO DATABASE
// ============================================================================

async function ingestDatabase(
  _videos: VideoInfo[],
  _playlistName: string,
  config: BatchProcessingConfig
): Promise<ProcessingResult> {
  const stageStart = Date.now();
  const errors: Array<{ videoId: string; error: string }> = [];
  let successful = 0;
  let failed = 0;

  const chunksPath = join(
    process.cwd(),
    'knowledge-base',
    'chunks',
    config.playlist,
    '_all-chunks.json'
  );

  if (!existsSync(chunksPath)) {
    console.log(`   ⚠️  No chunks found at ${chunksPath}`);
    return {
      stage: 'ingest',
      playlist: config.playlist,
      successful: 0,
      failed: 0,
      total: 0,
      duration: Date.now() - stageStart,
      errors: [{ videoId: 'all', error: 'No chunks file found' }],
    };
  }

  console.log(`   📂 Loading chunks from ${chunksPath}`);
  const chunks: KnowledgeChunk[] = JSON.parse(await readFile(chunksPath, 'utf-8'));
  console.log(`   📦 Found ${chunks.length} chunks to ingest`);

  // Insert chunks in batches
  const batchSize = 100;
  const now = new Date();

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(chunks.length / batchSize);

    console.log(`   [Batch ${batchNum}/${totalBatches}] Inserting ${batch.length} chunks...`);

    try {
      // Insert each chunk
      for (const chunk of batch) {
        await db.insert(knowledgeChunks).values({
          content: chunk.content,
          sourceType: chunk.sourceType,
          sourceUrl: chunk.sourceUrl,
          videoId: chunk.videoId,
          timestamp: chunk.timestamp,
          concept: chunk.concept,
          section: chunk.section,
          filePath: chunk.filePath,
          tokenCount: chunk.tokenCount,
          createdAt: now,
        });
        successful++;
      }
      console.log(`              ✅ Inserted ${batch.length} chunks`);
    } catch (error) {
      failed += batch.length;
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({ videoId: 'batch', error: errorMsg });
      console.log(`              ❌ Batch failed: ${errorMsg.slice(0, 50)}`);
    }
  }

  return {
    stage: 'ingest',
    playlist: config.playlist,
    successful,
    failed,
    total: chunks.length,
    duration: Date.now() - stageStart,
    errors,
  };
}

// ============================================================================
// STAGE 5: GENERATE EMBEDDINGS
// ============================================================================

async function generateEmbeddings(config: BatchProcessingConfig): Promise<ProcessingResult> {
  const stageStart = Date.now();
  const errors: Array<{ videoId: string; error: string }> = [];
  let successful = 0;
  let failed = 0;

  // Check Ollama status
  console.log('   🔍 Checking Ollama status...');
  const status = await checkOllamaStatus();

  if (!status.available) {
    console.log(`   ❌ Ollama not available: ${status.error}`);
    console.log('   💡 Start Ollama with: ollama serve');
    return {
      stage: 'embed',
      playlist: config.playlist,
      successful: 0,
      failed: 0,
      total: 0,
      duration: Date.now() - stageStart,
      errors: [{ videoId: 'all', error: status.error ?? 'Ollama not available' }],
    };
  }

  if (!status.modelLoaded) {
    console.log('   ⚠️  nomic-embed-text model not loaded');
    console.log('   💡 Pull model with: ollama pull nomic-embed-text');
    return {
      stage: 'embed',
      playlist: config.playlist,
      successful: 0,
      failed: 0,
      total: 0,
      duration: Date.now() - stageStart,
      errors: [{ videoId: 'all', error: 'nomic-embed-text model not loaded' }],
    };
  }

  console.log('   ✅ Ollama ready with nomic-embed-text');

  // Get chunks without embeddings
  const chunksWithoutEmbeddings = await db
    .select()
    .from(knowledgeChunks)
    .where(isNull(knowledgeChunks.embedding));

  const total = chunksWithoutEmbeddings.length;
  console.log(`   📊 Found ${total} chunks without embeddings`);

  if (total === 0) {
    console.log('   ✅ All chunks already have embeddings');
    return {
      stage: 'embed',
      playlist: config.playlist,
      successful: 0,
      failed: 0,
      total: 0,
      duration: Date.now() - stageStart,
      errors: [],
    };
  }

  // Process in batches
  const batchSize = 50;

  for (let i = 0; i < chunksWithoutEmbeddings.length; i += batchSize) {
    const batch = chunksWithoutEmbeddings.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(total / batchSize);

    console.log(`   [Batch ${batchNum}/${totalBatches}] Embedding ${batch.length} chunks...`);

    try {
      // Convert to KnowledgeChunk format for embedder
      const chunkObjects: KnowledgeChunk[] = batch.map((row) => ({
        id: row.id,
        content: row.content,
        sourceType: row.sourceType as 'youtube' | 'notion' | 'manual',
        sourceUrl: row.sourceUrl ?? undefined,
        videoId: row.videoId ?? undefined,
        concept: row.concept ?? undefined,
        section: row.section ?? undefined,
      }));

      // Generate embeddings
      const embeddedChunks = await embedChunks(chunkObjects, {
        onProgress: (completed, total) => {
          process.stdout.write(`\r              Progress: ${completed}/${total}`);
        },
      });
      console.log(''); // New line after progress

      // Update database with embeddings
      for (const chunk of embeddedChunks) {
        if (chunk.id && chunk.embedding) {
          await db
            .update(knowledgeChunks)
            .set({ embedding: JSON.stringify(chunk.embedding) })
            .where(eq(knowledgeChunks.id, chunk.id));
          successful++;
        }
      }

      console.log(`              ✅ Embedded ${batch.length} chunks`);
    } catch (error) {
      failed += batch.length;
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({ videoId: 'batch', error: errorMsg });
      console.log(`              ❌ Batch failed: ${errorMsg.slice(0, 50)}`);
    }
  }

  return {
    stage: 'embed',
    playlist: config.playlist,
    successful,
    failed,
    total,
    duration: Date.now() - stageStart,
    errors,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function loadVideoList(): Promise<VideoListJson> {
  const listPath = join(process.cwd(), 'scripts', 'ict-video-list.json');
  const content = await readFile(listPath, 'utf-8');
  return JSON.parse(content) as VideoListJson;
}

async function upsertVideoSource(
  videoId: string,
  title: string,
  playlistId: string,
  playlistName: string,
  status: 'pending' | 'transcribed' | 'processed' | 'error',
  errorMessage?: string
): Promise<void> {
  const now = new Date();

  // Check if exists
  const existing = await db
    .select()
    .from(videoSources)
    .where(eq(videoSources.videoId, videoId))
    .limit(1);

  if (existing.length > 0) {
    // Update
    await db
      .update(videoSources)
      .set({
        status,
        errorMessage,
        processedAt: status === 'processed' ? now : undefined,
      })
      .where(eq(videoSources.videoId, videoId));
  } else {
    // Insert
    await db.insert(videoSources).values({
      videoId,
      title,
      playlistId,
      playlistName,
      status,
      errorMessage,
      createdAt: now,
    });
  }
}

function buildTranscriptMarkdown(
  transcript: TranscriptResult & { title?: string; playlistName?: string },
  title: string
): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push('---');
  lines.push(`title: "${title}"`);
  lines.push(`slug: ${transcript.videoId}`);
  lines.push('category: youtube-transcript');
  lines.push(`created: ${new Date().toISOString().split('T')[0]}`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${title}`);
  lines.push('');

  // Create multiple sections for better chunking
  // Each section will become a separate chunk
  if (transcript.groupedSegments && transcript.groupedSegments.length > 0) {
    // Group every 5 segments into a section (~2-3 min of content)
    const sectionSize = 5;
    let sectionNum = 1;

    for (let i = 0; i < transcript.groupedSegments.length; i += sectionSize) {
      const group = transcript.groupedSegments.slice(i, i + sectionSize);
      const startTime = group[0]?.timestamp ?? '0:00';

      lines.push(`## Section ${sectionNum} [${startTime}]`);
      lines.push('');

      for (const segment of group) {
        lines.push(`**[${segment.timestamp}]** ${segment.text}`);
        lines.push('');
      }

      sectionNum++;
    }
  } else if (transcript.segments && transcript.segments.length > 0) {
    // Group every 20 segments into a section
    const sectionSize = 20;
    let sectionNum = 1;

    for (let i = 0; i < transcript.segments.length; i += sectionSize) {
      const group = transcript.segments.slice(i, i + sectionSize);
      const text = group.map((s) => s.text).join(' ');
      const startTime = group[0]?.start ?? 0;
      const timestamp = formatTimestamp(startTime);

      lines.push(`## Section ${sectionNum} [${timestamp}]`);
      lines.push('');
      lines.push(text);
      lines.push('');

      sectionNum++;
    }
  } else if (transcript.fullText) {
    // Split full text into ~500 word sections
    const words = transcript.fullText.split(/\s+/);
    const wordsPerSection = 400;
    let sectionNum = 1;

    for (let i = 0; i < words.length; i += wordsPerSection) {
      const sectionWords = words.slice(i, i + wordsPerSection);
      lines.push(`## Section ${sectionNum}`);
      lines.push('');
      lines.push(sectionWords.join(' '));
      lines.push('');

      sectionNum++;
    }
  }

  return lines.join('\n');
}

function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function printSummary(results: ProcessingResult[], startTime: number) {
  const totalDuration = Date.now() - startTime;

  console.log('\n' + '═'.repeat(60));
  console.log('✅ Batch Ingestion Complete');
  console.log('═'.repeat(60));

  console.log(`\n📊 By Stage:`);
  for (const result of results) {
    const percentage =
      result.total > 0 ? ((result.successful / result.total) * 100).toFixed(1) : '0';
    const status = result.failed === 0 ? '✅' : '⚠️';
    console.log(
      `   ${status} ${result.stage.padEnd(10)}: ${result.successful}/${result.total} (${percentage}%) in ${formatDuration(result.duration)}`
    );

    if (result.errors.length > 0) {
      for (const err of result.errors.slice(0, 3)) {
        console.log(`      ❌ ${err.videoId}: ${err.error.slice(0, 40)}...`);
      }
      if (result.errors.length > 3) {
        console.log(`      ... and ${result.errors.length - 3} more errors`);
      }
    }
  }

  console.log(`\n⏱️  Total Duration: ${formatDuration(totalDuration)}`);

  // Get current database stats
  const totalChunks = await db.select().from(knowledgeChunks);
  const chunksWithEmbeddings = totalChunks.filter((c) => c.embedding !== null);
  const totalVideos = await db.select().from(videoSources);

  console.log(`\n📚 Database Status:`);
  console.log(`   📹 Videos tracked: ${totalVideos.length}`);
  console.log(`   📦 Total chunks: ${totalChunks.length}`);
  console.log(
    `   🧠 Chunks with embeddings: ${chunksWithEmbeddings.length} (${((chunksWithEmbeddings.length / totalChunks.length) * 100).toFixed(1)}%)`
  );

  console.log(`\n🚀 Next Steps:`);
  console.log(`   1. Run: pnpm dev`);
  console.log(`   2. Test search at: http://localhost:3000/kb-search`);
  console.log(`   3. Generate flashcards: npx tsx scripts/generate-flashcards.ts`);
  console.log('');
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const config: BatchProcessingConfig = {
    playlist: 'default',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--playlist' && args[i + 1]) {
      config.playlist = args[++i] ?? config.playlist;
    } else if (args[i] === '--limit' && args[i + 1]) {
      config.limit = parseInt(args[++i] ?? '0', 10);
    } else if (args[i] === '--resume') {
      config.resume = true;
    } else if (args[i] === '--embed') {
      config.embed = true;
    } else if (args[i] === '--skip-transcript') {
      config.skipTranscript = true;
    } else if (args[i] === '--skip-processing') {
      config.skipProcessing = true;
    }
  }

  if (!config.playlist || config.playlist === 'default') {
    console.error('❌ Playlist required: --playlist <name>');
    console.error('\nUsage:');
    console.error(
      '  npx tsx scripts/batch-ingest-all.ts --playlist <name> [--limit N] [--embed] [--resume]'
    );
    console.error('\nAvailable playlists:');
    console.error('  - if-i-could-go-back');
    console.error('  - market-maker-series');
    console.error('  - 2022-mentorship');
    console.error('\nOptions:');
    console.error('  --limit N          Process only first N videos');
    console.error('  --embed            Generate embeddings after ingestion');
    console.error('  --resume           Skip already processed videos');
    console.error('  --skip-transcript  Skip transcript extraction');
    console.error('  --skip-processing  Skip LLM concept extraction');
    process.exit(1);
  }

  await runBatchIngestion(config);
}

main();
