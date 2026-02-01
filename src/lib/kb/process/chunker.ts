/**
 * Chunking pipeline for knowledge base content.
 * Splits markdown into embedding-friendly chunks while preserving context.
 */

import type { KnowledgeChunk } from '../types';
import { parseFrontmatter, extractSections } from '../ingest/markdown';

// Rough token estimation (1 token ≈ 4 characters for English)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface ChunkOptions {
  maxTokens?: number; // Maximum tokens per chunk
  overlap?: number; // Overlap in tokens between chunks
  minTokens?: number; // Minimum tokens for a chunk to be valid
}

const DEFAULT_OPTIONS: Required<ChunkOptions> = {
  maxTokens: 512,
  overlap: 50,
  minTokens: 30,
};

/**
 * Split text by sentences while respecting token limits.
 */
function splitBySentences(text: string, maxTokens: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    const combined = currentChunk + (currentChunk ? ' ' : '') + sentence.trim();
    if (estimateTokens(combined) > maxTokens && currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence.trim();
    } else {
      currentChunk = combined;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Split text by paragraphs while respecting token limits.
 */
function splitByParagraphs(text: string, maxTokens: number): string[] {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
  const chunks: string[] = [];
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    const combined = currentChunk + (currentChunk ? '\n\n' : '') + paragraph;

    if (estimateTokens(combined) > maxTokens && currentChunk) {
      chunks.push(currentChunk.trim());
      // If single paragraph is too long, split by sentences
      if (estimateTokens(paragraph) > maxTokens) {
        chunks.push(...splitBySentences(paragraph, maxTokens));
        currentChunk = '';
      } else {
        currentChunk = paragraph;
      }
    } else {
      currentChunk = combined;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Add overlap between chunks for better context continuity.
 */
function addOverlap(chunks: string[], overlapTokens: number): string[] {
  if (chunks.length <= 1 || overlapTokens === 0) return chunks;

  const overlappedChunks: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i] ?? '';

    // Add end of previous chunk as context
    if (i > 0) {
      const prevChunk = chunks[i - 1] ?? '';
      const prevWords = prevChunk.split(/\s+/);
      const overlapWords = Math.min(overlapTokens, Math.floor(prevWords.length / 4));
      const overlap = prevWords.slice(-overlapWords).join(' ');
      chunk = `...${overlap} ${chunk}`;
    }

    overlappedChunks.push(chunk);
  }

  return overlappedChunks;
}

/**
 * Chunk markdown content by headers (structure-aware chunking).
 */
export function chunkByHeaders(
  markdown: string,
  options: ChunkOptions = {}
): KnowledgeChunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { frontmatter } = parseFrontmatter(markdown);
  const sections = extractSections(markdown);

  const chunks: KnowledgeChunk[] = [];
  const filePath = (frontmatter.slug as string) || undefined;
  const concept = (frontmatter.slug as string) || (frontmatter.category as string) || undefined;

  for (const section of sections) {
    // Skip empty sections
    if (!section.content.trim()) continue;

    const sectionHeader = section.header;
    const sectionTokens = estimateTokens(section.content);

    // If section is small enough, keep as single chunk
    if (sectionTokens <= opts.maxTokens) {
      if (sectionTokens >= opts.minTokens) {
        chunks.push({
          content: `## ${sectionHeader}\n\n${section.content}`,
          sourceType: 'youtube', // Default, should be overridden
          concept,
          section: sectionHeader,
          filePath,
          tokenCount: sectionTokens,
        });
      }
      continue;
    }

    // Split large sections by paragraphs
    const paragraphChunks = splitByParagraphs(section.content, opts.maxTokens);
    const overlappedChunks = addOverlap(paragraphChunks, opts.overlap);

    for (const chunkContent of overlappedChunks) {
      const tokenCount = estimateTokens(chunkContent);
      if (tokenCount >= opts.minTokens) {
        chunks.push({
          content: `## ${sectionHeader}\n\n${chunkContent}`,
          sourceType: 'youtube',
          concept,
          section: sectionHeader,
          filePath,
          tokenCount,
        });
      }
    }
  }

  return chunks;
}

/**
 * Chunk plain text without header structure.
 */
export function chunkPlainText(
  text: string,
  options: ChunkOptions = {}
): string[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // First try paragraphs
  let chunks = splitByParagraphs(text, opts.maxTokens);

  // Add overlap
  chunks = addOverlap(chunks, opts.overlap);

  // Filter by minimum size
  return chunks.filter((chunk) => estimateTokens(chunk) >= opts.minTokens);
}

/**
 * Create chunks from a markdown file for a specific video source.
 */
export function createVideoChunks(
  markdown: string,
  videoId: string,
  sourceUrl: string,
  options: ChunkOptions = {}
): KnowledgeChunk[] {
  const chunks = chunkByHeaders(markdown, options);

  return chunks.map((chunk) => ({
    ...chunk,
    sourceType: 'youtube' as const,
    sourceUrl,
    videoId,
  }));
}

/**
 * Merge very small consecutive chunks if they're from the same section.
 */
export function mergeSmallChunks(
  chunks: KnowledgeChunk[],
  minTokens: number = 100
): KnowledgeChunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: KnowledgeChunk[] = [];
  let current: KnowledgeChunk | null = null;

  for (const chunk of chunks) {
    if (!current) {
      current = { ...chunk };
      continue;
    }

    // Can merge if same section and combined size is reasonable
    const currentTokens = current.tokenCount ?? estimateTokens(current.content);
    const chunkTokens = chunk.tokenCount ?? estimateTokens(chunk.content);
    const combinedTokens = currentTokens + chunkTokens;

    if (
      currentTokens < minTokens &&
      current.section === chunk.section &&
      combinedTokens <= 600
    ) {
      current.content += '\n\n' + chunk.content;
      current.tokenCount = combinedTokens;
    } else {
      merged.push(current);
      current = { ...chunk };
    }
  }

  if (current) {
    merged.push(current);
  }

  return merged;
}
