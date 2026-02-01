#!/usr/bin/env npx tsx
/**
 * Ingest a YouTube video into the ICT knowledge base.
 *
 * Usage:
 *   npx tsx scripts/ingest-video.ts <video_url_or_id> [--title "Video Title"] [--playlist "Playlist Name"]
 *
 * Example:
 *   npx tsx scripts/ingest-video.ts "https://youtube.com/watch?v=abc123" --title "ICT 2022 Mentorship Ep 1" --playlist "2022 Mentorship"
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getTranscript, extractVideoId } from '../src/lib/kb/ingest/youtube';
import { generateConceptMarkdown } from '../src/lib/kb/ingest/markdown';
import { processTranscript } from '../src/lib/kb/process/structurer';
import { createVideoChunks, mergeSmallChunks } from '../src/lib/kb/process/chunker';
import { embedChunks, checkOllamaStatus, pullEmbeddingModel } from '../src/lib/kb/process/embedder';
import { generateFlashcards } from '../src/lib/kb/flashcards/generator';
import { exportToTSV, getAnkiImportInstructions } from '../src/lib/kb/flashcards/anki';
import { db } from '../src/lib/data/db';
import { videoSources, knowledgeChunks, flashcards } from '../src/lib/data/schema';
import { eq } from 'drizzle-orm';

interface IngestOptions {
  videoUrl: string;
  title?: string;
  playlist?: string;
  skipFlashcards?: boolean;
  skipEmbeddings?: boolean;
}

async function parseArgs(): Promise<IngestOptions> {
  const args = process.argv.slice(2);

  if (args.length === 0 || !args[0]) {
    console.error('Usage: npx tsx scripts/ingest-video.ts <video_url> [--title "Title"] [--playlist "Playlist"]');
    process.exit(1);
  }

  const options: IngestOptions = {
    videoUrl: args[0],
  };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--title' && args[i + 1]) {
      options.title = args[++i];
    } else if (args[i] === '--playlist' && args[i + 1]) {
      options.playlist = args[++i];
    } else if (args[i] === '--skip-flashcards') {
      options.skipFlashcards = true;
    } else if (args[i] === '--skip-embeddings') {
      options.skipEmbeddings = true;
    }
  }

  return options;
}

async function main() {
  const options = await parseArgs();
  const videoId = extractVideoId(options.videoUrl);

  console.log(`\n📹 Processing video: ${videoId}`);
  console.log('─'.repeat(50));

  // Step 1: Check if already processed
  const existing = await db.select().from(videoSources).where(eq(videoSources.videoId, videoId)).limit(1);
  if (existing.length > 0 && existing[0]?.status === 'processed') {
    console.log('⚠️  Video already processed. Use --force to reprocess.');
    return;
  }

  // Step 2: Extract transcript
  console.log('\n📝 Extracting transcript...');
  const transcript = await getTranscript(videoId, { grouped: true });

  if (transcript.error) {
    console.error(`❌ Failed to extract transcript: ${transcript.error}`);
    await db.insert(videoSources).values({
      videoId,
      title: options.title,
      playlistName: options.playlist,
      status: 'error',
      errorMessage: transcript.error,
      createdAt: new Date(),
    }).onConflictDoUpdate({
      target: videoSources.videoId,
      set: { status: 'error', errorMessage: transcript.error },
    });
    process.exit(1);
  }

  console.log(`✓ Extracted ${transcript.segments?.length ?? 0} segments`);

  // Save transcript status
  await db.insert(videoSources).values({
    videoId,
    title: options.title ?? `Video ${videoId}`,
    playlistName: options.playlist,
    status: 'transcribed',
    createdAt: new Date(),
  }).onConflictDoUpdate({
    target: videoSources.videoId,
    set: { status: 'transcribed' },
  });

  // Step 3: Structure transcript with Claude
  console.log('\n🧠 Structuring content with Claude...');
  const { concepts, summary } = await processTranscript(
    transcript.groupedSegments ?? transcript.fullText ?? '',
    videoId,
    options.title ?? `Video ${videoId}`,
    options.playlist
  );

  console.log(`✓ Extracted ${concepts.length} concepts`);
  console.log(`  Summary: ${summary.slice(0, 100)}...`);

  // Step 4: Generate and save markdown files
  console.log('\n📄 Generating markdown files...');
  const knowledgeBaseDir = join(process.cwd(), 'knowledge-base');
  const sourcesDir = join(knowledgeBaseDir, 'sources', 'youtube');
  await mkdir(sourcesDir, { recursive: true });

  for (const concept of concepts) {
    const markdown = generateConceptMarkdown(concept);
    const categoryDir = join(knowledgeBaseDir, 'concepts', concept.frontmatter.category);
    await mkdir(categoryDir, { recursive: true });

    const filename = `${concept.frontmatter.slug}.md`;
    const filepath = join(categoryDir, filename);

    await writeFile(filepath, markdown, 'utf-8');
    console.log(`  ✓ ${filepath}`);
  }

  // Step 5: Create and store chunks
  console.log('\n🔪 Creating knowledge chunks...');
  let allChunks: Awaited<ReturnType<typeof createVideoChunks>> = [];

  for (const concept of concepts) {
    const markdown = generateConceptMarkdown(concept);
    const chunks = createVideoChunks(
      markdown,
      videoId,
      `https://www.youtube.com/watch?v=${videoId}`
    );
    allChunks.push(...chunks);
  }

  allChunks = mergeSmallChunks(allChunks);
  console.log(`✓ Created ${allChunks.length} chunks`);

  // Step 6: Generate embeddings (if not skipped)
  if (!options.skipEmbeddings) {
    console.log('\n🔢 Generating embeddings...');

    const status = await checkOllamaStatus();
    if (!status.available) {
      console.log('⚠️  Ollama not available. Run: ollama serve');
      console.log('   Skipping embeddings...');
    } else if (!status.modelLoaded) {
      console.log('📥 Pulling nomic-embed-text model...');
      await pullEmbeddingModel();
    }

    if (status.available) {
      allChunks = await embedChunks(allChunks, {
        onProgress: (done, total) => {
          process.stdout.write(`\r  Embedding ${done}/${total}...`);
        },
      });
      console.log('\n✓ Embeddings generated');
    }
  }

  // Step 7: Store chunks in database
  console.log('\n💾 Storing chunks in database...');
  for (const chunk of allChunks) {
    await db.insert(knowledgeChunks).values({
      content: chunk.content,
      sourceType: chunk.sourceType,
      sourceUrl: chunk.sourceUrl,
      videoId: chunk.videoId,
      timestamp: chunk.timestamp,
      concept: chunk.concept,
      section: chunk.section,
      filePath: chunk.filePath,
      embedding: chunk.embedding ? JSON.stringify(chunk.embedding) : null,
      tokenCount: chunk.tokenCount,
      createdAt: new Date(),
    });
  }
  console.log(`✓ Stored ${allChunks.length} chunks`);

  // Step 8: Generate flashcards (if not skipped)
  if (!options.skipFlashcards) {
    console.log('\n🎴 Generating flashcards...');

    const cards = await generateFlashcards(allChunks, {
      onProgress: (done, total) => {
        process.stdout.write(`\r  Processing chunk ${done}/${total}...`);
      },
    });
    console.log(`\n✓ Generated ${cards.length} flashcards`);

    // Store flashcards
    for (const card of cards) {
      await db.insert(flashcards).values({
        chunkId: card.chunkId,
        type: card.type,
        front: card.front,
        back: card.back,
        tags: JSON.stringify(card.tags),
        state: card.state,
        difficulty: card.difficulty,
        stability: card.stability,
        reps: card.reps,
        lapses: card.lapses,
        createdAt: new Date(),
      });
    }

    // Export to Anki format
    const exportDir = join(knowledgeBaseDir, 'exports', 'anki');
    await mkdir(exportDir, { recursive: true });

    const tsvPath = join(exportDir, `${videoId}.txt`);
    await exportToTSV(cards, tsvPath);
    console.log(`\n📦 Exported to: ${tsvPath}`);
    console.log(getAnkiImportInstructions(tsvPath));
  }

  // Step 9: Update video status
  await db.update(videoSources)
    .set({ status: 'processed', processedAt: new Date() })
    .where(eq(videoSources.videoId, videoId));

  console.log('\n' + '─'.repeat(50));
  console.log('✅ Video ingestion complete!');
  console.log(`   Concepts: ${concepts.length}`);
  console.log(`   Chunks: ${allChunks.length}`);
  console.log(`   Video ID: ${videoId}`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
