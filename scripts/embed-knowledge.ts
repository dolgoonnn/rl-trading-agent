#!/usr/bin/env npx tsx
/**
 * Generate embeddings for knowledge base markdown files.
 * Step 3 of the manual ingestion workflow (after Claude Code structures content).
 *
 * Usage:
 *   npx tsx scripts/embed-knowledge.ts [--concept <slug>]
 *
 * Processes all .md files in knowledge-base/concepts/ and stores embeddings in SQLite.
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { db } from '../src/lib/data/db';
import { knowledgeChunks } from '../src/lib/data/schema';
import { chunkByHeaders, mergeSmallChunks } from '../src/lib/kb/process/chunker';
import { embedChunks, checkOllamaStatus, pullEmbeddingModel } from '../src/lib/kb/process/embedder';
import { parseFrontmatter } from '../src/lib/kb/ingest/markdown';
import type { KnowledgeChunk } from '../src/lib/kb/types';

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await findMarkdownFiles(fullPath)));
      } else if (entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return files;
}

async function main() {
  const conceptsDir = join(process.cwd(), 'knowledge-base', 'concepts');

  console.log('\n🔍 Scanning for markdown files...');
  const mdFiles = await findMarkdownFiles(conceptsDir);

  if (mdFiles.length === 0) {
    console.log('❌ No markdown files found in knowledge-base/concepts/');
    console.log('   Run extract-transcript.ts first, then ask Claude Code to structure it.');
    process.exit(1);
  }

  console.log(`✓ Found ${mdFiles.length} markdown files`);

  // Check Ollama
  console.log('\n🔌 Checking Ollama...');
  const status = await checkOllamaStatus();

  if (!status.available) {
    console.error('❌ Ollama not running. Start with: ollama serve');
    process.exit(1);
  }

  if (!status.modelLoaded) {
    console.log('📥 Pulling nomic-embed-text model...');
    await pullEmbeddingModel();
  }

  console.log('✓ Ollama ready');

  // Process each file
  console.log('\n📄 Processing files...');
  let totalChunks = 0;

  for (const filePath of mdFiles) {
    const relativePath = filePath.replace(process.cwd() + '/', '');
    process.stdout.write(`   ${relativePath}...`);

    const content = await readFile(filePath, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);

    // Create chunks
    let chunks = chunkByHeaders(content);
    chunks = mergeSmallChunks(chunks);

    // Add source info
    const enrichedChunks: KnowledgeChunk[] = chunks.map((chunk) => ({
      ...chunk,
      sourceType: 'manual' as const,
      filePath: relativePath,
      concept: (frontmatter.slug as string) || (frontmatter.category as string) || undefined,
    }));

    // Generate embeddings
    const embeddedChunks = await embedChunks(enrichedChunks);

    // Store in database
    for (const chunk of embeddedChunks) {
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

    console.log(` ${embeddedChunks.length} chunks`);
    totalChunks += embeddedChunks.length;
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Embedded ${totalChunks} chunks from ${mdFiles.length} files`);
  console.log('   Stored in SQLite database for semantic search');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
