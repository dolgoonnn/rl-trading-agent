/**
 * LLM-based transcript structuring using Claude API.
 * Converts raw YouTube transcripts into structured ICT concept markdown.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ConceptContent, ConceptFrontmatter, ConceptCategory } from '../types';
import type { GroupedSegment } from '../ingest/youtube';

const anthropic = new Anthropic();

// ICT concept mapping for categorization
const ICT_CONCEPTS: Record<string, { category: ConceptCategory; phase: number }> = {
  'swing-points': { category: 'market-structure', phase: 2 },
  bos: { category: 'market-structure', phase: 2 },
  choch: { category: 'market-structure', phase: 2 },
  mss: { category: 'market-structure', phase: 2 },
  liquidity: { category: 'liquidity', phase: 1 },
  bsl: { category: 'liquidity', phase: 2 },
  ssl: { category: 'liquidity', phase: 2 },
  inducement: { category: 'liquidity', phase: 2 },
  'order-blocks': { category: 'price-delivery', phase: 3 },
  'fair-value-gaps': { category: 'price-delivery', phase: 3 },
  'breaker-blocks': { category: 'price-delivery', phase: 3 },
  'mitigation-blocks': { category: 'price-delivery', phase: 3 },
  'premium-discount': { category: 'price-delivery', phase: 2 },
  equilibrium: { category: 'price-delivery', phase: 2 },
  ote: { category: 'entry-models', phase: 4 },
  amd: { category: 'entry-models', phase: 4 },
  'kill-zones': { category: 'time-theory', phase: 4 },
  'silver-bullet': { category: 'entry-models', phase: 6 },
  'smt-divergence': { category: 'entry-models', phase: 6 },
  'macro-times': { category: 'time-theory', phase: 5 },
  ipda: { category: 'time-theory', phase: 5 },
};

const STRUCTURING_PROMPT = `You are an expert ICT (Inner Circle Trader) trading educator. Your task is to analyze a YouTube video transcript and extract structured trading knowledge.

## ICT Concepts to Look For
- Market Structure: swing points, BOS (Break of Structure), CHoCH (Change of Character), MSS
- Liquidity: BSL (Buy-side liquidity), SSL (Sell-side liquidity), inducement, stop hunts
- Price Delivery: Order Blocks, Fair Value Gaps (FVG), Breaker Blocks, Mitigation Blocks
- Premium/Discount zones, Equilibrium (50% level)
- Entry Models: OTE (Optimal Trade Entry), AMD (Accumulation-Manipulation-Distribution)
- Time Theory: Kill Zones, Macro Times, IPDA

## Your Task
Analyze the transcript and output a JSON object with the following structure:

{
  "mainConcepts": [
    {
      "slug": "concept-slug",
      "title": "Concept Name",
      "definition": "Clear, concise definition",
      "keyCharacteristics": ["point 1", "point 2"],
      "tradingApplication": ["how to use 1", "how to use 2"],
      "rules": ["specific trading rule if mentioned"],
      "relatedConcepts": ["other-concept-slug"]
    }
  ],
  "quotes": [
    {
      "text": "Important quote from ICT",
      "concept": "related-concept-slug",
      "timestamp": "12:34"
    }
  ],
  "summary": "2-3 sentence summary of what this video teaches"
}

## Guidelines
1. Focus on ACTIONABLE trading knowledge
2. Use ICT's exact terminology
3. Extract specific rules and conditions when mentioned
4. Note timestamps for key insights (use provided timestamps)
5. If a concept is only briefly mentioned, still include it but with less detail
6. Keep definitions under 100 words
7. Keep each key characteristic under 30 words

## Video Transcript
Title: {{TITLE}}
Playlist: {{PLAYLIST}}

{{TRANSCRIPT}}

Respond with only the JSON object, no markdown code blocks.`;

interface StructuredTranscript {
  mainConcepts: Array<{
    slug: string;
    title: string;
    definition: string;
    keyCharacteristics: string[];
    tradingApplication: string[];
    rules?: string[];
    relatedConcepts: string[];
  }>;
  quotes: Array<{
    text: string;
    concept: string;
    timestamp?: string;
  }>;
  summary: string;
}

/**
 * Structure a transcript using Claude API.
 */
export async function structureTranscript(
  transcript: string | GroupedSegment[],
  videoTitle: string,
  playlistName?: string
): Promise<StructuredTranscript> {
  // Build transcript string with timestamps if available
  let transcriptText: string;

  if (typeof transcript === 'string') {
    transcriptText = transcript;
  } else {
    transcriptText = transcript
      .map((seg) => `[${seg.timestamp}] ${seg.text}`)
      .join('\n');
  }

  const prompt = STRUCTURING_PROMPT.replace('{{TITLE}}', videoTitle)
    .replace('{{PLAYLIST}}', playlistName ?? 'Unknown')
    .replace('{{TRANSCRIPT}}', transcriptText);

  const response = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const content = response.content[0];
  if (!content || content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  // Parse JSON response
  const jsonText = content.text.trim();
  return JSON.parse(jsonText) as StructuredTranscript;
}

/**
 * Convert structured transcript to ConceptContent objects.
 */
export function toConceptContents(
  structured: StructuredTranscript,
  videoId: string,
  videoTitle: string,
  playlistName?: string
): ConceptContent[] {
  const today = new Date().toISOString().split('T')[0] ?? '';

  return structured.mainConcepts.map((concept) => {
    const conceptInfo = ICT_CONCEPTS[concept.slug] ?? {
      category: 'market-structure' as ConceptCategory,
      phase: 2,
    };

    // Find quotes for this concept
    const conceptQuotes = structured.quotes.filter((q) => q.concept === concept.slug);

    const frontmatter: ConceptFrontmatter = {
      title: concept.title,
      slug: concept.slug,
      category: conceptInfo.category,
      source: {
        type: 'youtube',
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        playlist: playlistName,
      },
      concepts: concept.relatedConcepts,
      difficulty: conceptInfo.phase <= 2 ? 'beginner' : conceptInfo.phase <= 4 ? 'intermediate' : 'advanced',
      phase: conceptInfo.phase,
      created: today,
    };

    return {
      frontmatter,
      definition: concept.definition,
      keyCharacteristics: concept.keyCharacteristics,
      tradingApplication: concept.tradingApplication,
      rules: concept.rules,
      relatedConcepts: concept.relatedConcepts,
      sourceNotes: conceptQuotes.map((q) => ({
        quote: q.text,
        source: videoTitle,
        timestamp: q.timestamp,
      })),
    };
  });
}

/**
 * Process a video transcript end-to-end.
 * Returns structured concepts ready for markdown generation.
 */
export async function processTranscript(
  transcript: string | GroupedSegment[],
  videoId: string,
  videoTitle: string,
  playlistName?: string
): Promise<{
  concepts: ConceptContent[];
  summary: string;
}> {
  const structured = await structureTranscript(transcript, videoTitle, playlistName);
  const concepts = toConceptContents(structured, videoId, videoTitle, playlistName);

  return {
    concepts,
    summary: structured.summary,
  };
}
