/**
 * Knowledge Base type definitions.
 */

// ICT Concept categories
export type ConceptCategory =
  | 'market-structure'
  | 'liquidity'
  | 'price-delivery'
  | 'entry-models'
  | 'time-theory'
  | 'psychology';

// ICT Concept slugs
export type ConceptSlug =
  | 'swing-points'
  | 'bos'
  | 'choch'
  | 'mss'
  | 'liquidity'
  | 'bsl'
  | 'ssl'
  | 'inducement'
  | 'order-blocks'
  | 'fair-value-gaps'
  | 'breaker-blocks'
  | 'mitigation-blocks'
  | 'premium-discount'
  | 'equilibrium'
  | 'ote'
  | 'amd'
  | 'kill-zones'
  | 'silver-bullet'
  | 'smt-divergence'
  | 'macro-times'
  | 'ipda';

// Markdown frontmatter structure
export interface ConceptFrontmatter {
  title: string;
  slug: ConceptSlug | string;
  category: ConceptCategory;
  source?: {
    type: 'youtube' | 'notion' | 'manual';
    url?: string;
    videoId?: string;
    timestamp?: string;
    playlist?: string;
  };
  concepts: string[]; // Related concept slugs
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  phase: number; // Learning phase 1-7
  created: string; // ISO date
  updated?: string;
}

// Structured concept content
export interface ConceptContent {
  frontmatter: ConceptFrontmatter;
  definition: string;
  keyCharacteristics: string[];
  visualPattern?: string; // ASCII or description
  tradingApplication: string[];
  rules?: string[]; // Specific trading rules
  examples?: string[];
  relatedConcepts: string[];
  sourceNotes?: Array<{
    quote: string;
    source: string;
    timestamp?: string;
  }>;
}

// Chunk for embedding
export interface KnowledgeChunk {
  id?: number;
  content: string;
  sourceType: 'youtube' | 'notion' | 'manual';
  sourceUrl?: string;
  videoId?: string;
  timestamp?: string;
  concept?: string;
  section?: string;
  filePath?: string;
  embedding?: number[];
  tokenCount?: number;
}

// Flashcard types
export type FlashcardType = 'basic' | 'cloze' | 'sequence';

export interface Flashcard {
  id?: number;
  chunkId?: number;
  type: FlashcardType;
  front: string;
  back: string;
  tags: string[];
  // FSRS state
  state: 'new' | 'learning' | 'review' | 'relearning';
  difficulty: number;
  stability: number;
  due?: Date;
  lastReview?: Date;
  reps: number;
  lapses: number;
}

// Video processing status
export type VideoStatus = 'pending' | 'transcribed' | 'processed' | 'error';

export interface VideoSource {
  id?: number;
  videoId: string;
  title?: string;
  channelName?: string;
  playlistId?: string;
  playlistName?: string;
  duration?: number;
  publishedAt?: Date;
  status: VideoStatus;
  errorMessage?: string;
  transcriptPath?: string;
  processedAt?: Date;
  createdAt: Date;
}
