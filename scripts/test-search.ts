#!/usr/bin/env npx tsx
/**
 * Quick test of semantic search functionality
 */

import { semanticSearch } from '../src/lib/kb/search/semantic';

async function testSearch() {
  console.log('🔍 Testing ICT Knowledge Base Search\n');

  const queries = [
    'What is a fair value gap?',
    'How to identify order blocks?',
    'Kill zones and session timing',
    'Smart money concepts',
    'Liquidity pools',
  ];

  for (const query of queries) {
    console.log(`\n📝 Query: "${query}"`);
    console.log('─'.repeat(60));

    try {
      const results = await semanticSearch(query, { topK: 3, minSimilarity: 0.3 });

      if (results.length === 0) {
        console.log('   No results found');
        continue;
      }

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (!result) continue;
        console.log(
          `\n   [${i + 1}] Similarity: ${(result.similarity * 100).toFixed(1)}%`
        );
        console.log(`       Section: ${result.chunk.section ?? 'N/A'}`);
        console.log(`       Video: ${result.chunk.videoId ?? 'N/A'}`);
        console.log(`       Content: ${result.chunk.content.slice(0, 150)}...`);
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log('\n\n✅ Search test complete!');
}

testSearch().catch(console.error);
