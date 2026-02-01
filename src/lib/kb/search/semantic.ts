/**
 * Semantic search for knowledge base.
 * Supports both in-memory search and sqlite-vec for production.
 */

import { db } from '../../data/db';
import { knowledgeChunks } from '../../data/schema';
import type { KnowledgeChunk } from '../types';
import { generateEmbedding, cosineSimilarity } from '../process/embedder';
import { eq, like, or } from 'drizzle-orm';

export interface SearchResult {
  chunk: KnowledgeChunk;
  similarity: number;
  highlight?: string;
}

export interface SearchOptions {
  topK?: number;
  concept?: string;
  minSimilarity?: number;
}

/**
 * Semantic search using embeddings.
 * Falls back to in-memory cosine similarity if sqlite-vec is not available.
 */
export async function semanticSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { topK = 5, concept, minSimilarity = 0.3 } = options;

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);

  // Fetch all chunks (with optional concept filter)
  let dbQuery = db.select().from(knowledgeChunks);

  const rows = await (concept
    ? dbQuery.where(eq(knowledgeChunks.concept, concept))
    : dbQuery);

  // Parse embeddings and compute similarity
  const results: SearchResult[] = [];

  for (const row of rows) {
    if (!row.embedding) continue;

    let embedding: number[];
    try {
      embedding = JSON.parse(row.embedding) as number[];
    } catch {
      continue;
    }

    const similarity = cosineSimilarity(queryEmbedding, embedding);
    if (similarity < minSimilarity) continue;

    results.push({
      chunk: {
        id: row.id,
        content: row.content,
        sourceType: row.sourceType as 'youtube' | 'notion' | 'manual',
        sourceUrl: row.sourceUrl ?? undefined,
        videoId: row.videoId ?? undefined,
        timestamp: row.timestamp ?? undefined,
        concept: row.concept ?? undefined,
        section: row.section ?? undefined,
        filePath: row.filePath ?? undefined,
        tokenCount: row.tokenCount ?? undefined,
      },
      similarity,
    });
  }

  // Sort by similarity and take top K
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

/**
 * Keyword search as fallback/supplement to semantic search.
 */
export async function keywordSearch(
  query: string,
  options: { topK?: number; concept?: string } = {}
): Promise<KnowledgeChunk[]> {
  const { topK = 10 } = options;

  // Split query into keywords
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 2);

  if (keywords.length === 0) return [];

  // Build LIKE conditions for each keyword
  const conditions = keywords.map((keyword) =>
    like(knowledgeChunks.content, `%${keyword}%`)
  );

  const dbQuery = db
    .select()
    .from(knowledgeChunks)
    .where(or(...conditions))
    .limit(topK);

  const rows = await dbQuery;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    sourceType: row.sourceType as 'youtube' | 'notion' | 'manual',
    sourceUrl: row.sourceUrl ?? undefined,
    videoId: row.videoId ?? undefined,
    timestamp: row.timestamp ?? undefined,
    concept: row.concept ?? undefined,
    section: row.section ?? undefined,
    filePath: row.filePath ?? undefined,
    tokenCount: row.tokenCount ?? undefined,
  }));
}

/**
 * Hybrid search combining semantic and keyword search.
 */
export async function hybridSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { topK = 5 } = options;

  // Run both searches in parallel
  const [semanticResults, keywordResults] = await Promise.all([
    semanticSearch(query, { ...options, topK: topK * 2 }),
    keywordSearch(query, { topK: topK * 2, concept: options.concept }),
  ]);

  // Merge results, boosting items that appear in both
  const seen = new Map<number, SearchResult>();

  for (const result of semanticResults) {
    if (result.chunk.id) {
      seen.set(result.chunk.id, result);
    }
  }

  // Boost keyword matches that also have high semantic similarity
  for (const chunk of keywordResults) {
    if (chunk.id && seen.has(chunk.id)) {
      const existing = seen.get(chunk.id)!;
      existing.similarity *= 1.2; // 20% boost for keyword match
    } else if (chunk.id) {
      // Add keyword-only results with lower base similarity
      seen.set(chunk.id, { chunk, similarity: 0.4 });
    }
  }

  // Sort and return top K
  const merged = Array.from(seen.values());
  merged.sort((a, b) => b.similarity - a.similarity);
  return merged.slice(0, topK);
}

/**
 * Get related chunks for a given concept.
 */
export async function getRelatedChunks(
  concept: string,
  limit: number = 10
): Promise<KnowledgeChunk[]> {
  const rows = await db
    .select()
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.concept, concept))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    sourceType: row.sourceType as 'youtube' | 'notion' | 'manual',
    sourceUrl: row.sourceUrl ?? undefined,
    videoId: row.videoId ?? undefined,
    timestamp: row.timestamp ?? undefined,
    concept: row.concept ?? undefined,
    section: row.section ?? undefined,
    filePath: row.filePath ?? undefined,
    tokenCount: row.tokenCount ?? undefined,
  }));
}

/**
 * Build context for RAG from search results.
 */
export function buildRAGContext(
  results: SearchResult[],
  maxTokens: number = 4000
): string {
  const chunks: string[] = [];
  let tokenCount = 0;

  for (const result of results) {
    const chunkTokens = result.chunk.tokenCount ?? Math.ceil(result.chunk.content.length / 4);

    if (tokenCount + chunkTokens > maxTokens) break;

    const source = result.chunk.videoId
      ? `[Source: YouTube ${result.chunk.videoId}${result.chunk.timestamp ? ` @ ${result.chunk.timestamp}` : ''}]`
      : result.chunk.filePath
        ? `[Source: ${result.chunk.filePath}]`
        : '';

    chunks.push(`${result.chunk.content}\n${source}`);
    tokenCount += chunkTokens;
  }

  return chunks.join('\n\n---\n\n');
}
