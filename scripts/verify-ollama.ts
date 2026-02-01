#!/usr/bin/env node
/**
 * Verify Ollama setup and embedding model availability.
 */

import { checkOllamaStatus, generateEmbedding } from '../src/lib/kb/process/embedder';

async function verify() {
  console.log('🔍 Checking Ollama setup...\n');

  // Check Ollama status
  const status = await checkOllamaStatus();

  console.log('Ollama Status:');
  console.log(`  Available: ${status.available ? '✅' : '❌'}`);
  console.log(`  Model Loaded: ${status.modelLoaded ? '✅' : '❌'}`);

  if (status.error) {
    console.log(`  Error: ${status.error}`);
  }

  if (!status.available) {
    console.error('\n❌ Ollama is not running. Start it with:');
    console.error('   ollama serve');
    console.error('\nThen pull the embedding model:');
    console.error('   ollama pull nomic-embed-text');
    process.exit(1);
  }

  if (!status.modelLoaded) {
    console.error('\n❌ Embedding model not loaded.');
    console.error('   Pull it with: ollama pull nomic-embed-text');
    process.exit(1);
  }

  // Test embedding
  console.log('\nTesting embedding generation...');
  try {
    const testText = 'This is a test of the ICT knowledge base embedding system.';
    const embedding = await generateEmbedding(testText);

    console.log(`  ✅ Successfully generated ${embedding.length}-dimensional embedding`);
    console.log(`  Sample values: [${embedding.slice(0, 3).map((v) => v.toFixed(4)).join(', ')}, ...]`);
  } catch (error) {
    console.error(`  ❌ Failed to generate embedding:`);
    console.error(`     ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log('\n✅ Ollama is ready for knowledge base ingestion!');
  console.log('\nNext step: Run "pnpm tsx scripts/ingest-concepts.ts"');
}

verify().catch(console.error);
