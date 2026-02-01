/**
 * tRPC router for knowledge base search and retrieval.
 */

import { z } from 'zod';
import { router, publicProcedure } from '../init';
import { keywordSearch, semanticSearch, hybridSearch, getRelatedChunks, buildRAGContext } from '../../kb/search/semantic';

export const kbRouter = router({
  /**
   * Keyword search for knowledge base chunks.
   * Works without Ollama embeddings.
   */
  search: publicProcedure
    .input(
      z.object({
        query: z.string().min(1, 'Search query required'),
        concept: z.string().optional(),
        topK: z.number().int().min(1).max(50).optional().default(10),
      })
    )
    .query(async ({ input }) => {
      try {
        const results = await keywordSearch(input.query, {
          topK: input.topK,
          concept: input.concept,
        });

        return {
          success: true,
          query: input.query,
          resultCount: results.length,
          results: results.map((chunk) => ({
            id: chunk.id,
            content: chunk.content,
            section: chunk.section,
            concept: chunk.concept,
            filePath: chunk.filePath,
            sourceType: chunk.sourceType,
            videoId: chunk.videoId,
            sourceUrl: chunk.sourceUrl,
            tokenCount: chunk.tokenCount,
          })),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Search failed',
          results: [],
          resultCount: 0,
        };
      }
    }),

  /**
   * Semantic search using vector embeddings.
   * Requires Ollama to be running for query embedding.
   */
  semanticSearch: publicProcedure
    .input(
      z.object({
        query: z.string().min(1, 'Search query required'),
        concept: z.string().optional(),
        topK: z.number().int().min(1).max(50).optional().default(10),
        minSimilarity: z.number().min(0).max(1).optional().default(0.3),
      })
    )
    .query(async ({ input }) => {
      try {
        const results = await semanticSearch(input.query, {
          topK: input.topK,
          concept: input.concept,
          minSimilarity: input.minSimilarity,
        });

        return {
          success: true,
          query: input.query,
          resultCount: results.length,
          results: results.map((result) => ({
            id: result.chunk.id,
            content: result.chunk.content,
            section: result.chunk.section,
            concept: result.chunk.concept,
            filePath: result.chunk.filePath,
            sourceType: result.chunk.sourceType,
            videoId: result.chunk.videoId,
            sourceUrl: result.chunk.sourceUrl,
            tokenCount: result.chunk.tokenCount,
            similarity: result.similarity,
          })),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Semantic search failed (is Ollama running?)',
          results: [],
          resultCount: 0,
        };
      }
    }),

  /**
   * Hybrid search combining semantic and keyword search.
   * Best of both worlds - semantic understanding + exact matches.
   */
  hybridSearch: publicProcedure
    .input(
      z.object({
        query: z.string().min(1, 'Search query required'),
        concept: z.string().optional(),
        topK: z.number().int().min(1).max(50).optional().default(10),
      })
    )
    .query(async ({ input }) => {
      try {
        const results = await hybridSearch(input.query, {
          topK: input.topK,
          concept: input.concept,
        });

        return {
          success: true,
          query: input.query,
          resultCount: results.length,
          results: results.map((result) => ({
            id: result.chunk.id,
            content: result.chunk.content,
            section: result.chunk.section,
            concept: result.chunk.concept,
            filePath: result.chunk.filePath,
            sourceType: result.chunk.sourceType,
            videoId: result.chunk.videoId,
            sourceUrl: result.chunk.sourceUrl,
            tokenCount: result.chunk.tokenCount,
            similarity: result.similarity,
          })),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Hybrid search failed',
          results: [],
          resultCount: 0,
        };
      }
    }),

  /**
   * Get all chunks for a specific concept.
   */
  concept: publicProcedure
    .input(
      z.object({
        concept: z.string().min(1, 'Concept slug required'),
        limit: z.number().int().min(1).max(100).optional().default(20),
      })
    )
    .query(async ({ input }) => {
      try {
        const chunks = await getRelatedChunks(input.concept, input.limit);

        return {
          success: true,
          concept: input.concept,
          chunkCount: chunks.length,
          chunks: chunks.map((chunk) => ({
            id: chunk.id,
            content: chunk.content,
            section: chunk.section,
            concept: chunk.concept,
            filePath: chunk.filePath,
            sourceType: chunk.sourceType,
            videoId: chunk.videoId,
            sourceUrl: chunk.sourceUrl,
            tokenCount: chunk.tokenCount,
          })),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch concept',
          chunks: [],
          chunkCount: 0,
        };
      }
    }),

  /**
   * Build RAG context from search results (for passing to LLM).
   */
  ragContext: publicProcedure
    .input(
      z.object({
        query: z.string().min(1, 'Search query required'),
        concept: z.string().optional(),
        maxTokens: z.number().int().min(100).max(16000).optional().default(4000),
      })
    )
    .query(async ({ input }) => {
      try {
        const searchResults = await keywordSearch(input.query, {
          topK: 20,
          concept: input.concept,
        });

        // Convert to SearchResult format for buildRAGContext
        const resultsWithSimilarity = searchResults.map((chunk) => ({
          chunk,
          similarity: 1.0, // Keyword search doesn't provide similarity scores
        }));

        const context = buildRAGContext(resultsWithSimilarity, input.maxTokens);

        return {
          success: true,
          query: input.query,
          context,
          contextLength: context.length,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to build RAG context',
          context: '',
          contextLength: 0,
        };
      }
    }),

  /**
   * Get search suggestions based on concept names and popular terms.
   */
  suggestions: publicProcedure
    .input(
      z.object({
        query: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional().default(10),
      })
    )
    .query(async () => {
      // Return popular ICT concepts for autocomplete
      const suggestions = [
        'order blocks',
        'fair value gap',
        'liquidity',
        'market structure',
        'intermediate term high',
        'precision market structure',
        'market structure hierarchy',
        'daily bias',
        'kill zone',
        'smart money',
        'stop hunt',
        'premium discount',
        'power three',
        'judas swing',
        'market structure break',
        'order block confirmation',
        'equal lows',
        'equal highs',
        'inducement',
        'displacement',
      ];

      return {
        success: true,
        suggestions,
      };
    }),
});
