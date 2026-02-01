/**
 * Embedding generation using Ollama's nomic-embed-text model.
 * Generates 768-dimensional vectors for semantic search.
 */

import type { KnowledgeChunk } from '../types';

const OLLAMA_BASE_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const EMBEDDING_MODEL = 'nomic-embed-text';

interface OllamaEmbeddingResponse {
  embedding: number[];
}

/**
 * Generate embedding for a single text using Ollama.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      prompt: text,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama embedding failed: ${error}`);
  }

  const result = (await response.json()) as OllamaEmbeddingResponse;
  return result.embedding;
}

/**
 * Generate embeddings for multiple texts in batch.
 * Processes sequentially to avoid overwhelming Ollama.
 */
export async function generateEmbeddings(
  texts: string[],
  options: { onProgress?: (completed: number, total: number) => void } = {}
): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (!text) continue;
    const embedding = await generateEmbedding(text);
    embeddings.push(embedding);

    if (options.onProgress) {
      options.onProgress(i + 1, texts.length);
    }
  }

  return embeddings;
}

/**
 * Add embeddings to knowledge chunks.
 */
export async function embedChunks(
  chunks: KnowledgeChunk[],
  options: { onProgress?: (completed: number, total: number) => void } = {}
): Promise<KnowledgeChunk[]> {
  const texts = chunks.map((c) => c.content);
  const embeddings = await generateEmbeddings(texts, options);

  return chunks.map((chunk, i) => ({
    ...chunk,
    embedding: embeddings[i],
  }));
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Find most similar chunks to a query.
 * Fallback for when sqlite-vec is not available.
 */
export function findSimilarChunks(
  queryEmbedding: number[],
  chunks: KnowledgeChunk[],
  topK: number = 5
): Array<KnowledgeChunk & { similarity: number }> {
  const scored = chunks
    .filter((c) => c.embedding)
    .map((chunk) => ({
      ...chunk,
      similarity: cosineSimilarity(queryEmbedding, chunk.embedding!),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, topK);
}

/**
 * Check if Ollama is running and the embedding model is available.
 */
export async function checkOllamaStatus(): Promise<{
  available: boolean;
  modelLoaded: boolean;
  error?: string;
}> {
  try {
    // Check if Ollama is running
    const tagsResponse = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!tagsResponse.ok) {
      return { available: false, modelLoaded: false, error: 'Ollama not responding' };
    }

    const tags = (await tagsResponse.json()) as { models: Array<{ name: string }> };
    const modelLoaded = tags.models.some((m) =>
      m.name.includes(EMBEDDING_MODEL)
    );

    return { available: true, modelLoaded };
  } catch (error) {
    return {
      available: false,
      modelLoaded: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Pull the embedding model if not already available.
 */
export async function pullEmbeddingModel(): Promise<void> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: EMBEDDING_MODEL }),
  });

  if (!response.ok) {
    throw new Error(`Failed to pull model: ${await response.text()}`);
  }

  // Stream response until complete
  const reader = response.body?.getReader();
  if (!reader) return;

  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}
