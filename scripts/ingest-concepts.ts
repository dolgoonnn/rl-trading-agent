#!/usr/bin/env node
/**
 * Ingest all ICT concept markdown files into the knowledge base.
 * Chunks are created immediately; embeddings are generated with Ollama (optional).
 *
 * Usage:
 *   pnpm tsx scripts/ingest-concepts.ts              # Without embeddings
 *   pnpm tsx scripts/ingest-concepts.ts --with-embeddings  # With embeddings (requires Ollama)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../src/lib/data/db';
import { knowledgeChunks } from '../src/lib/data/schema';
import { chunkByHeaders, mergeSmallChunks } from '../src/lib/kb/process/chunker';
import { generateEmbedding, checkOllamaStatus } from '../src/lib/kb/process/embedder';
import { parseFrontmatter } from '../src/lib/kb/ingest/markdown';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const CONCEPTS_DIR = path.join(PROJECT_ROOT, 'knowledge-base', 'concepts');
const WITH_EMBEDDINGS = process.argv.includes('--with-embeddings');

interface ConceptFile {
  path: string;
  slug: string;
  category: string;
  title: string;
  sourceVideoId?: string;
  sourceUrl?: string;
}

/**
 * Find all concept markdown files recursively.
 */
function findConceptFiles(dir: string): ConceptFile[] {
  const files: ConceptFile[] = [];

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const { frontmatter } = parseFrontmatter(content);

        files.push({
          path: fullPath,
          slug: (frontmatter.slug as string) || entry.name.replace('.md', ''),
          category: (frontmatter.category as string) || 'uncategorized',
          title: (frontmatter.title as string) || entry.name,
          sourceVideoId: (frontmatter.source as Record<string, string> | undefined)?.videoId,
          sourceUrl: (frontmatter.source as Record<string, string> | undefined)?.url,
        });
      }
    }
  }

  walk(dir);
  return files.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Main ingestion pipeline.
 */
async function ingestConcepts() {
  console.log('🚀 Starting ICT concept ingestion...\n');

  let ollamaAvailable = false;

  if (WITH_EMBEDDINGS) {
    console.log('⏳ Checking Ollama status...');
    const ollamaStatus = await checkOllamaStatus();

    if (ollamaStatus.available && ollamaStatus.modelLoaded) {
      ollamaAvailable = true;
      console.log('✅ Ollama ready for embeddings\n');
    } else {
      console.warn('⚠️  Ollama not available. Skipping embeddings.');
      console.warn('   To enable embeddings, install Ollama and run: ollama pull nomic-embed-text\n');
    }
  } else {
    console.log('ℹ️  Storing chunks without embeddings (use --with-embeddings to generate)\n');
  }

  // Find all concept files
  console.log('📂 Scanning concept files...');
  const conceptFiles = findConceptFiles(CONCEPTS_DIR);
  console.log(`   Found ${conceptFiles.length} concept files\n`);

  if (conceptFiles.length === 0) {
    console.log('⚠️  No concept files found. Exiting.');
    process.exit(0);
  }

  // Process each concept
  let totalChunks = 0;
  let totalEmbeddings = 0;

  for (let i = 0; i < conceptFiles.length; i++) {
    const file = conceptFiles[i];
    if (!file) continue;

    const progress = `[${i + 1}/${conceptFiles.length}]`;

    console.log(`${progress} Processing: ${file.title}`);

    try {
      // Read and parse markdown
      const content = fs.readFileSync(file.path, 'utf-8');
      parseFrontmatter(content); // Verify parsing works

      // Create chunks
      const rawChunks = chunkByHeaders(content);
      const chunks = mergeSmallChunks(rawChunks);

      console.log(`   📦 Created ${chunks.length} chunks`);

      // Store chunks (with or without embeddings)
      let chunkCount = 0;
      for (const chunk of chunks) {
        try {
          let embedding: string | undefined;

          // Generate embedding if Ollama is available
          if (ollamaAvailable && WITH_EMBEDDINGS) {
            try {
              const embeddingVector = await generateEmbedding(chunk.content);
              embedding = JSON.stringify(embeddingVector);
              totalEmbeddings++;

              // Rate limiting for Ollama
              await new Promise((resolve) => setTimeout(resolve, 50));
            } catch (embeddingError) {
              console.warn(
                `      ⚠️  Failed to embed chunk: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`
              );
            }
          }

          // Store in database
          await db.insert(knowledgeChunks).values({
            content: chunk.content,
            sourceType: 'manual',
            sourceUrl: file.sourceUrl,
            videoId: file.sourceVideoId,
            concept: file.slug,
            section: chunk.section,
            filePath: file.slug,
            embedding: embedding,
            tokenCount: chunk.tokenCount,
            createdAt: new Date(),
          });

          chunkCount++;
        } catch (error) {
          console.error(`      ❌ Failed to store chunk: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      totalChunks += chunks.length;
      console.log(`   ✅ Stored ${chunkCount}/${chunks.length} chunks\n`);
    } catch (error) {
      console.error(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // Summary
  console.log('\n📊 Ingestion Complete');
  console.log(`   Total concepts: ${conceptFiles.length}`);
  console.log(`   Total chunks: ${totalChunks}`);
  console.log(`   Total embeddings: ${totalEmbeddings}`);

  if (!ollamaAvailable && WITH_EMBEDDINGS) {
    console.log('\n📝 To generate embeddings later:');
    console.log('   1. Install Ollama from https://ollama.ai');
    console.log('   2. Pull the embedding model: ollama pull nomic-embed-text');
    console.log('   3. Run: pnpm tsx scripts/ingest-concepts.ts --with-embeddings');
  }

  console.log('\n✨ Knowledge base ready!');
}

ingestConcepts().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
