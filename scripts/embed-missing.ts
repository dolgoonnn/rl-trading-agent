/**
 * Embed chunks that are missing embeddings
 */

import { db } from '../src/lib/data/db';
import { knowledgeChunks } from '../src/lib/data/schema';
import { generateEmbedding } from '../src/lib/kb/process/embedder';
import { isNull, eq } from 'drizzle-orm';

async function embedMissing() {
  console.log('🔍 Finding chunks without embeddings...');

  const missing = await db
    .select()
    .from(knowledgeChunks)
    .where(isNull(knowledgeChunks.embedding));

  console.log(`   Found ${missing.length} chunks to embed\n`);

  if (missing.length === 0) {
    console.log('✅ All chunks have embeddings!');
    return;
  }

  let success = 0;
  let errors = 0;

  for (let i = 0; i < missing.length; i++) {
    const chunk = missing[i];
    if (!chunk) continue;
    process.stdout.write(`[${i + 1}/${missing.length}] Embedding chunk ${chunk.id}... `);

    try {
      const embedding = await generateEmbedding(chunk.content);

      await db
        .update(knowledgeChunks)
        .set({ embedding: JSON.stringify(embedding) })
        .where(eq(knowledgeChunks.id, chunk.id));

      console.log('✅');
      success++;
    } catch (error) {
      console.log(`❌ ${error instanceof Error ? error.message : 'Unknown error'}`);
      errors++;
    }
  }

  console.log(`\n✅ Embedded ${success} chunks`);
  if (errors > 0) {
    console.log(`⚠️  ${errors} errors`);
  }
}

embedMissing().catch(console.error);
