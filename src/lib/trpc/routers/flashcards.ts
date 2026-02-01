/**
 * tRPC router for flashcard study and management.
 */

import { z } from 'zod';
import { router, publicProcedure } from '../init';
import { db } from '../../data/db';
import { flashcards } from '../../data/schema';
import { eq, lte, or, isNull } from 'drizzle-orm';
import { calculateNextReview } from '../../kb/flashcards/generator';

/**
 * Get flashcards due for review today.
 */
const getDueCards = publicProcedure
  .input(
    z.object({
      limit: z.number().int().min(1).max(100).optional().default(20),
    })
  )
  .query(async ({ input }) => {
    const now = new Date();

    // Get cards that are:
    // 1. New cards (never reviewed)
    // 2. Due for review (due date <= now)
    const cards = await db
      .select()
      .from(flashcards)
      .where(or(isNull(flashcards.due), lte(flashcards.due, now)))
      .limit(input.limit);

    return {
      success: true,
      cardCount: cards.length,
      cards: cards.map((card) => ({
        id: card.id,
        front: card.front,
        back: card.back,
        type: card.type as 'basic' | 'cloze' | 'sequence',
        tags: card.tags ? JSON.parse(card.tags) : [],
        state: card.state,
      })),
    };
  });

/**
 * Record a study session result for a flashcard.
 */
const recordReview = publicProcedure
  .input(
    z.object({
      cardId: z.number().int().positive(),
      rating: z.enum(['1', '2', '3', '4']).transform((v) => parseInt(v) as 1 | 2 | 3 | 4),
      timeSpent: z.number().int().optional(), // milliseconds
    })
  )
  .mutation(async ({ input }) => {
    try {
      // Fetch the card
      const card = await db.select().from(flashcards).where(eq(flashcards.id, input.cardId));

      if (card.length === 0) {
        return {
          success: false,
          error: 'Card not found',
        };
      }

      const currentCard = card[0];
      if (!currentCard) {
        return {
          success: false,
          error: 'Card not found',
        };
      }

      // Convert to Flashcard type for FSRS calculation
      const flashcardForFSRS = {
        id: currentCard.id,
        chunkId: currentCard.chunkId ?? undefined,
        type: currentCard.type as 'basic' | 'cloze' | 'sequence',
        front: currentCard.front,
        back: currentCard.back,
        tags: currentCard.tags ? (JSON.parse(currentCard.tags) as string[]) : [],
        state: currentCard.state as 'new' | 'learning' | 'review' | 'relearning',
        difficulty: currentCard.difficulty ?? 0,
        stability: currentCard.stability ?? 0,
        due: currentCard.due ?? undefined,
        lastReview: currentCard.lastReview ?? undefined,
        reps: currentCard.reps ?? 0,
        lapses: currentCard.lapses ?? 0,
        createdAt: currentCard.createdAt,
      };

      // Calculate next review using FSRS
      const { nextDue, newState } = calculateNextReview(
        flashcardForFSRS,
        input.rating
      );

      // Update card in database
      await db
        .update(flashcards)
        .set({
          state: newState.state,
          difficulty: newState.difficulty,
          stability: newState.stability,
          reps: newState.reps,
          lapses: newState.lapses,
          due: nextDue,
          lastReview: new Date(),
        })
        .where(eq(flashcards.id, input.cardId));

      return {
        success: true,
        cardId: input.cardId,
        nextDue,
        newState,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to record review',
      };
    }
  });

/**
 * Get study statistics for a concept.
 */
const getConceptStats = publicProcedure
  .input(
    z.object({
      concept: z.string().optional(),
    })
  )
  .query(async ({ input }) => {
    try {
      // Get all flashcards (or filtered by concept if specified)
      let query = db.select().from(flashcards);

      // Note: Full text search on tags would be ideal, but for now we'll get all and filter in-memory
      const allCards = await query;

      // Filter by concept if specified
      const cards = input.concept
        ? allCards.filter((c) => c.tags && JSON.parse(c.tags).includes(input.concept!))
        : allCards;

      // Calculate statistics
      const stats = {
        total: cards.length,
        new: cards.filter((c) => c.state === 'new').length,
        learning: cards.filter((c) => c.state === 'learning').length,
        review: cards.filter((c) => c.state === 'review').length,
        relearning: cards.filter((c) => c.state === 'relearning').length,
        dueToday: cards.filter(
          (c) => c.due == null || c.due <= new Date()
        ).length,
        byType: {
          basic: cards.filter((c) => c.type === 'basic').length,
          cloze: cards.filter((c) => c.type === 'cloze').length,
          sequence: cards.filter((c) => c.type === 'sequence').length,
        },
        avgDifficulty: cards.length > 0
          ? cards.reduce((sum, c) => sum + (c.difficulty ?? 0), 0) / cards.length
          : 0,
        avgStability: cards.length > 0
          ? cards.reduce((sum, c) => sum + (c.stability ?? 0), 0) / cards.length
          : 0,
      };

      return {
        success: true,
        concept: input.concept || 'all',
        stats,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get statistics',
        stats: null,
      };
    }
  });

/**
 * Get learning curve for a card (review history).
 */
const getCardHistory = publicProcedure
  .input(
    z.object({
      cardId: z.number().int().positive(),
    })
  )
  .query(async ({ input }) => {
    try {
      const cardResults = await db.select().from(flashcards).where(eq(flashcards.id, input.cardId));

      if (cardResults.length === 0) {
        return {
          success: false,
          error: 'Card not found',
          card: null,
        };
      }

      const c = cardResults[0];
      if (!c) {
        return {
          success: false,
          error: 'Card not found',
          card: null,
        };
      }

      return {
        success: true,
        card: {
          id: c.id,
          front: c.front,
          back: c.back,
          type: c.type as 'basic' | 'cloze' | 'sequence',
          state: c.state,
          reps: c.reps,
          lapses: c.lapses,
          difficulty: c.difficulty,
          stability: c.stability,
          lastReview: c.lastReview,
          due: c.due,
          createdAt: c.createdAt,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get history',
        card: null,
      };
    }
  });

export const flashcardsRouter = router({
  getDueCards,
  recordReview,
  getConceptStats,
  getCardHistory,
});
