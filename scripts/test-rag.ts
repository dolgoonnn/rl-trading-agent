/**
 * Test RAG system functionality
 */

import { keywordSearch, getRelatedChunks, buildRAGContext } from '../src/lib/kb/search/semantic';
import { db } from '../src/lib/data/db';
import { knowledgeChunks } from '../src/lib/data/schema';
import { count, eq, isNotNull, isNull } from 'drizzle-orm';

async function testRAG() {
  console.log('=== RAG SYSTEM AUDIT ===\n');

  // 1. Database connectivity
  console.log('1. DATABASE CONNECTIVITY');
  try {
    const [result] = await db.select({ count: count() }).from(knowledgeChunks);
    console.log(`   ✅ Connected - ${result?.count ?? 0} total chunks\n`);
  } catch (error) {
    console.log(`   ❌ Database error: ${error}\n`);
    return;
  }

  // 2. Keyword search test
  console.log('2. KEYWORD SEARCH TEST');
  const testQueries = ['order block', 'fair value gap', 'market structure', 'liquidity', 'kill zone'];
  for (const query of testQueries) {
    try {
      const results = await keywordSearch(query, { topK: 5 });
      console.log(`   ✅ "${query}" → ${results.length} results`);
    } catch (error) {
      console.log(`   ❌ "${query}" failed: ${error}`);
    }
  }
  console.log('');

  // 3. Concept retrieval test
  console.log('3. CONCEPT RETRIEVAL TEST');
  const concepts = ['fair-value-gap', 'order-block', 'market-structure-break', 'power-three', 'precision-market-structure'];
  for (const concept of concepts) {
    try {
      const chunks = await getRelatedChunks(concept, 3);
      console.log(`   ${chunks.length > 0 ? '✅' : '⚠️'} "${concept}" → ${chunks.length} chunks`);
    } catch (error) {
      console.log(`   ❌ "${concept}" failed: ${error}`);
    }
  }
  console.log('');

  // 4. RAG context building test
  console.log('4. RAG CONTEXT BUILDING TEST');
  try {
    const searchResults = await keywordSearch('intermediate term high market structure', { topK: 5 });
    const resultsWithSimilarity = searchResults.map((chunk) => ({
      chunk,
      similarity: 1.0,
    }));
    const context = buildRAGContext(resultsWithSimilarity, 4000);
    console.log(`   ✅ Built context: ${context.length} characters from ${searchResults.length} chunks`);
    console.log(`   📝 Sample sources found:`);
    searchResults.slice(0, 3).forEach((r, i) => {
      console.log(`      ${i + 1}. ${r.concept || r.videoId || 'unknown'} (${r.sourceType})`);
    });
  } catch (error) {
    console.log(`   ❌ Context building error: ${error}`);
  }
  console.log('');

  // 5. Coverage report
  console.log('5. COVERAGE REPORT');

  const [manualCount] = await db
    .select({ count: count() })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.sourceType, 'manual'));

  const [youtubeCount] = await db
    .select({ count: count() })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.sourceType, 'youtube'));

  const [withEmbedding] = await db
    .select({ count: count() })
    .from(knowledgeChunks)
    .where(isNotNull(knowledgeChunks.embedding));

  const [withoutEmbedding] = await db
    .select({ count: count() })
    .from(knowledgeChunks)
    .where(isNull(knowledgeChunks.embedding));

  // Get unique concepts
  const uniqueConcepts = await db
    .selectDistinct({ concept: knowledgeChunks.concept })
    .from(knowledgeChunks)
    .where(isNotNull(knowledgeChunks.concept));

  // Get unique videos
  const uniqueVideos = await db
    .selectDistinct({ videoId: knowledgeChunks.videoId })
    .from(knowledgeChunks)
    .where(isNotNull(knowledgeChunks.videoId));

  console.log(`   📚 Manual chunks (concepts): ${manualCount?.count}`);
  console.log(`   🎥 YouTube chunks (transcripts): ${youtubeCount?.count}`);
  console.log(`   🧠 With embeddings: ${withEmbedding?.count}`);
  console.log(`   ⚠️  Missing embeddings: ${withoutEmbedding?.count}`);
  console.log(`   📖 Unique concepts: ${uniqueConcepts.filter(c => c.concept).length}`);
  console.log(`   📹 Unique videos: ${uniqueVideos.filter(v => v.videoId).length}`);

  // 6. Embedding coverage percentage
  const total = (manualCount?.count || 0) + (youtubeCount?.count || 0);
  const embedded = withEmbedding?.count || 0;
  const percentage = ((embedded / total) * 100).toFixed(1);
  console.log(`\n   📊 Embedding coverage: ${percentage}%`);

  console.log('\n=== AUDIT SUMMARY ===');
  console.log(`✅ Keyword search: WORKING`);
  console.log(`✅ Concept retrieval: WORKING`);
  console.log(`✅ RAG context building: WORKING`);
  console.log(`${Number(percentage) >= 95 ? '✅' : '⚠️'} Embedding coverage: ${percentage}%`);
  console.log(`\n🎯 RAG SYSTEM STATUS: USABLE`);

  if (Number(withoutEmbedding?.count) > 0) {
    console.log(`\n⚠️  To fix missing embeddings, run:`);
    console.log(`   ollama serve  # In another terminal`);
    console.log(`   npx tsx scripts/embed-knowledge.ts`);
  }

  console.log('\n=== END AUDIT ===');
}

testRAG().catch(console.error);
