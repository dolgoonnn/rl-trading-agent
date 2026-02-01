#!/usr/bin/env node
/**
 * Generate flashcards from knowledge base chunks.
 * Uses Claude API to create FSRS-compatible study cards.
 *
 * Usage:
 *   pnpm tsx scripts/generate-flashcards.ts                    # Generate all
 *   pnpm tsx scripts/generate-flashcards.ts --concept order-blocks  # Single concept
 *   pnpm tsx scripts/generate-flashcards.ts --export            # Export to Anki TSV
 *   pnpm tsx scripts/generate-flashcards.ts --limit 50          # Sample run
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../src/lib/data/db';
import { knowledgeChunks, flashcards } from '../src/lib/data/schema';
import { generateFlashcardsFromChunk } from '../src/lib/kb/flashcards/generator';
import { exportByConceptToTSV, createStudySummary, getAnkiImportInstructions } from '../src/lib/kb/flashcards/anki';
import { eq } from 'drizzle-orm';
import fs from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const EXPORT_DIR = path.join(PROJECT_ROOT, 'knowledge-base', 'exports', 'anki');

// Parse command line arguments
const CONCEPT_FILTER = process.argv.find((arg) => arg.startsWith('--concept='))?.split('=')[1];
const EXPORT_MODE = process.argv.includes('--export');
const LIMIT = parseInt(process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] ?? '0', 10);

/**
 * Main flashcard generation pipeline.
 */
async function generateFlashcards() {
  console.log('🎓 ICT Flashcard Generation Pipeline\n');

  // Fetch chunks from database
  console.log('📂 Loading chunks from database...');
  let query = db.select().from(knowledgeChunks);

  if (CONCEPT_FILTER) {
    query = query.where(eq(knowledgeChunks.concept, CONCEPT_FILTER)) as typeof query;
  }

  let chunks = await query;

  if (LIMIT > 0) {
    chunks = chunks.slice(0, LIMIT);
  }

  console.log(`   Found ${chunks.length} chunks${CONCEPT_FILTER ? ` for concept: ${CONCEPT_FILTER}` : ''}\n`);

  if (chunks.length === 0) {
    console.log('⚠️  No chunks found. Exiting.');
    process.exit(0);
  }

  // Generate flashcards
  console.log('🤖 Generating flashcards with Claude API...\n');

  const allFlashcards: Array<{
    chunkId: number;
    type: 'basic' | 'cloze' | 'sequence';
    front: string;
    back: string;
    tags: string[];
  }> = [];

  let generatedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || !chunk.id) continue;

    const progress = `[${i + 1}/${chunks.length}]`;
    process.stdout.write(`${progress} Processing chunk ${chunk.id} (${chunk.concept || 'unknown'})... `);

    try {
      // Convert database row to KnowledgeChunk type
      const knowledgeChunk = {
        id: chunk.id,
        content: chunk.content,
        sourceType: chunk.sourceType as 'youtube' | 'notion' | 'manual',
        sourceUrl: chunk.sourceUrl ?? undefined,
        videoId: chunk.videoId ?? undefined,
        timestamp: chunk.timestamp ?? undefined,
        concept: chunk.concept ?? undefined,
        section: chunk.section ?? undefined,
        filePath: chunk.filePath ?? undefined,
        tokenCount: chunk.tokenCount ?? undefined,
      };

      const cards = await generateFlashcardsFromChunk(knowledgeChunk);

      // Store in database
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
          due: null,
          lastReview: null,
          reps: card.reps,
          lapses: card.lapses,
          createdAt: new Date(),
        });
      }

      allFlashcards.push(
        ...cards.map((c) => ({
          chunkId: c.chunkId ?? chunk.id,
          type: c.type,
          front: c.front,
          back: c.back,
          tags: c.tags,
        }))
      );

      generatedCount += cards.length;
      console.log(`✅ Generated ${cards.length} cards`);

      // Rate limiting for Claude API
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.log(
        `❌ Error: ${error instanceof Error ? error.message : String(error)}`
      );
      errorCount++;
    }
  }

  // Summary
  console.log('\n📊 Generation Complete');
  console.log(`   Chunks processed: ${chunks.length}`);
  console.log(`   Flashcards generated: ${generatedCount}`);
  console.log(`   Errors: ${errorCount}`);

  // Create study summary
  const summary = createStudySummary(
    allFlashcards.map((c) => ({
      id: undefined,
      chunkId: c.chunkId,
      type: c.type,
      front: c.front,
      back: c.back,
      tags: c.tags,
      state: 'new' as const,
      difficulty: 0,
      stability: 0,
      due: undefined,
      lastReview: undefined,
      reps: 0,
      lapses: 0,
      createdAt: new Date(),
    }))
  );

  console.log('\n📈 Card Statistics');
  console.log(`   Total: ${summary.total}`);
  console.log(`   By Type:`);
  for (const [type, count] of Object.entries(summary.byType)) {
    console.log(`     - ${type}: ${count}`);
  }
  console.log(`   By Concept (top 10):`);
  const sortedConcepts = Object.entries(summary.byConcept)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);
  for (const [concept, count] of sortedConcepts) {
    console.log(`     - ${concept}: ${count}`);
  }

  // Export to Anki if requested
  if (EXPORT_MODE || allFlashcards.length > 0) {
    console.log('\n📤 Exporting to Anki format...');

    try {
      // Ensure export directory exists
      await fs.mkdir(EXPORT_DIR, { recursive: true });

      // Convert flashcards to format with tags as arrays (for export)
      const flashcardsForExport = allFlashcards.map((c) => ({
        id: undefined,
        chunkId: c.chunkId,
        type: c.type,
        front: c.front,
        back: c.back,
        tags: c.tags,
        state: 'new' as const,
        difficulty: 0,
        stability: 0,
        due: undefined,
        lastReview: undefined,
        reps: 0,
        lapses: 0,
        createdAt: new Date(),
      }));

      const exportedFiles = await exportByConceptToTSV(flashcardsForExport, EXPORT_DIR);

      console.log(`   ✅ Exported ${exportedFiles.length} files to ${EXPORT_DIR}`);
      for (const file of exportedFiles.slice(0, 5)) {
        console.log(`     - ${path.basename(file)}`);
      }
      if (exportedFiles.length > 5) {
        console.log(`     ... and ${exportedFiles.length - 5} more`);
      }

      // Generate import instructions
      const instructionsPath = path.join(EXPORT_DIR, 'IMPORT_INSTRUCTIONS.md');
      const instructions = getAnkiImportInstructions(exportedFiles[0] ?? '');
      await fs.writeFile(instructionsPath, instructions, 'utf-8');
      console.log(`   📝 Import instructions: ${instructionsPath}`);
    } catch (error) {
      console.error(`   ❌ Export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Next steps
  console.log('\n🎯 Next Steps');
  if (generatedCount > 0) {
    console.log(`   1. Review generated flashcards in database`);
    console.log(`   2. Export to Anki: pnpm tsx scripts/generate-flashcards.ts --export`);
    console.log(`   3. Open Anki and import the TSV files`);
  }
}

generateFlashcards().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
