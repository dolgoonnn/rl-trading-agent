/**
 * Flashcard generation using Claude API.
 * Generates spaced repetition cards from knowledge chunks.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Flashcard, KnowledgeChunk } from '../types';

const anthropic = new Anthropic();

const FLASHCARD_PROMPT = `You are an expert at creating effective spaced repetition flashcards for ICT trading education.

## Rules for Creating Flashcards
1. Create atomic cards - ONE concept per card
2. Use cloze deletions for definitions (format: {{c1::answer}})
3. Include "why" questions, not just "what"
4. For trading setups, create sequence cards
5. Maximum 20 words per answer
6. Focus on practical trading application
7. Use ICT terminology exactly

## Flashcard Types
- basic: Simple question → answer
- cloze: Text with {{c1::hidden}} parts
- sequence: Ordered steps (use {{c1::}}, {{c2::}}, {{c3::}} for order)

## Output Format
Return a JSON array of flashcards:
[
  {
    "type": "basic",
    "front": "What is the purpose of a Fair Value Gap?",
    "back": "Price imbalance zone where price is likely to return to rebalance",
    "tags": ["fvg", "price-delivery"]
  },
  {
    "type": "cloze",
    "front": "A {{c1::Fair Value Gap}} is created when candle 3's low is above candle 1's high",
    "back": "Fair Value Gap",
    "tags": ["fvg", "definition"]
  },
  {
    "type": "sequence",
    "front": "Order the AMD phases: {{c1::?}} → {{c2::?}} → {{c3::?}}",
    "back": "Accumulation → Manipulation → Distribution",
    "tags": ["amd", "entry-models"]
  }
]

## Content to Process
Concept: {{CONCEPT}}
Section: {{SECTION}}

{{CONTENT}}

Generate 3-7 flashcards that test understanding of this content.
Respond with only the JSON array, no markdown.`;

interface GeneratedFlashcard {
  type: 'basic' | 'cloze' | 'sequence';
  front: string;
  back: string;
  tags: string[];
}

/**
 * Generate flashcards from a knowledge chunk using Claude.
 */
export async function generateFlashcardsFromChunk(
  chunk: KnowledgeChunk
): Promise<Flashcard[]> {
  const prompt = FLASHCARD_PROMPT.replace('{{CONCEPT}}', chunk.concept ?? 'ICT Trading')
    .replace('{{SECTION}}', chunk.section ?? 'General')
    .replace('{{CONTENT}}', chunk.content);

  const response = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 2048,
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

  const generated = JSON.parse(content.text.trim()) as GeneratedFlashcard[];

  return generated.map((card) => ({
    chunkId: chunk.id,
    type: card.type,
    front: card.front,
    back: card.back,
    tags: card.tags,
    state: 'new' as const,
    difficulty: 0,
    stability: 0,
    reps: 0,
    lapses: 0,
  }));
}

/**
 * Generate flashcards from multiple chunks.
 */
export async function generateFlashcards(
  chunks: KnowledgeChunk[],
  options: {
    onProgress?: (completed: number, total: number) => void;
    maxCardsPerChunk?: number;
  } = {}
): Promise<Flashcard[]> {
  const { onProgress, maxCardsPerChunk = 7 } = options;
  const allCards: Flashcard[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    try {
      const cards = await generateFlashcardsFromChunk(chunk);
      allCards.push(...cards.slice(0, maxCardsPerChunk));
    } catch (error) {
      console.error(`Failed to generate flashcards for chunk ${i}:`, error);
    }

    if (onProgress) {
      onProgress(i + 1, chunks.length);
    }
  }

  return allCards;
}

/**
 * Convert cloze flashcard format for Anki compatibility.
 * Anki uses {{c1::text}} format which we already use.
 */
export function formatForAnki(flashcard: Flashcard): {
  front: string;
  back: string;
  tags: string;
} {
  return {
    front: flashcard.front,
    back: flashcard.back,
    tags: flashcard.tags.join(' '),
  };
}

/**
 * FSRS-4.5 algorithm implementation for spaced repetition.
 * Simplified version for initial implementation.
 */
export interface FSRSParams {
  w: number[]; // FSRS weights
}

const DEFAULT_FSRS_PARAMS: FSRSParams = {
  w: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],
};

export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

interface FSRSState {
  difficulty: number;
  stability: number;
  state: 'new' | 'learning' | 'review' | 'relearning';
  reps: number;
  lapses: number;
}

/**
 * Calculate next review based on FSRS algorithm.
 */
export function calculateNextReview(
  card: Flashcard,
  rating: Rating,
  params: FSRSParams = DEFAULT_FSRS_PARAMS
): { nextDue: Date; newState: FSRSState } {
  const now = new Date();
  const w = params.w;

  // Helper to safely access w array
  const getW = (idx: number): number => w[idx] ?? 0;

  let difficulty = card.difficulty;
  let stability = card.stability;
  let state = card.state;
  let reps = card.reps;
  let lapses = card.lapses;

  // Initial difficulty for new cards
  if (state === 'new') {
    difficulty = getW(4) - getW(5) * (rating - 3);
    difficulty = Math.max(1, Math.min(10, difficulty));

    // Initial stability
    stability = getW(rating - 1);
    state = 'learning';
    reps = 1;
  } else {
    // Update difficulty
    const difficultyDelta = -getW(6) * (rating - 3);
    difficulty = Math.max(1, Math.min(10, difficulty + difficultyDelta));

    // Update stability based on rating
    if (rating === 1) {
      // Again - card lapses
      stability = getW(11);
      lapses += 1;
      state = 'relearning';
    } else {
      // Good or better - stability increases
      const stabilityMultiplier = Math.exp(getW(8)) * (11 - difficulty) * Math.pow(stability, -getW(9)) * (Math.exp(getW(10) * (1 - rating / 4)) - 1);
      stability = stability * (1 + stabilityMultiplier);
      state = 'review';
      reps += 1;
    }
  }

  // Calculate interval in days
  const requestedRetention = 0.9; // 90% target retention
  const interval = Math.max(1, Math.round(stability * Math.log(requestedRetention) / Math.log(0.9)));

  const nextDue = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);

  return {
    nextDue,
    newState: { difficulty, stability, state, reps, lapses },
  };
}
