/**
 * ICT Knowledge Base Module
 *
 * Provides functionality for:
 * - YouTube transcript extraction
 * - LLM-based content structuring
 * - Markdown generation
 * - Semantic search with embeddings
 * - Flashcard generation and spaced repetition
 */

// Types
export type {
  ConceptCategory,
  ConceptSlug,
  ConceptFrontmatter,
  ConceptContent,
  KnowledgeChunk,
  FlashcardType,
  Flashcard,
  VideoStatus,
  VideoSource,
} from './types';

// Ingestion
export {
  getTranscript,
  extractVideoId,
  formatTimestamp,
  getTimestampUrl,
} from './ingest/youtube';

export {
  parseFrontmatter,
  generateConceptMarkdown,
  extractSections,
  createConceptTemplate,
} from './ingest/markdown';

// Processing
export {
  structureTranscript,
  toConceptContents,
  processTranscript,
} from './process/structurer';

export {
  chunkByHeaders,
  chunkPlainText,
  createVideoChunks,
  mergeSmallChunks,
} from './process/chunker';

export {
  generateEmbedding,
  generateEmbeddings,
  embedChunks,
  cosineSimilarity,
  findSimilarChunks,
  checkOllamaStatus,
  pullEmbeddingModel,
} from './process/embedder';

// Search
export {
  semanticSearch,
  keywordSearch,
  hybridSearch,
  getRelatedChunks,
  buildRAGContext,
} from './search/semantic';

export type { SearchResult, SearchOptions } from './search/semantic';

// Flashcards
export {
  generateFlashcardsFromChunk,
  generateFlashcards,
  formatForAnki,
  calculateNextReview,
} from './flashcards/generator';

export type { Rating, FSRSParams } from './flashcards/generator';

export {
  toAnkiTSV,
  toAnkiJSON,
  exportToTSV,
  exportByConceptToTSV,
  getAnkiImportInstructions,
  createStudySummary,
} from './flashcards/anki';
