/**
 * Agent tRPC Router
 * API endpoints for the RL trading agent
 */

import { z } from 'zod';
import { router, publicProcedure } from '../init';
import type { Candle } from '@/types';
import {
  TradingEnvironment,
  DQNAgent,
  backtestAgent,
  Actions,
  actionToName,
} from '@/lib/rl';

// In-memory agent storage (for demo - in production, persist to DB)
let currentAgent: DQNAgent | null = null;
let agentMetadata: {
  createdAt: number;
  trainedEpisodes: number;
  lastBacktestResult: unknown | null;
} | null = null;

export const agentRouter = router({
  /**
   * Get current agent status
   */
  status: publicProcedure.query(() => {
    if (!currentAgent) {
      return {
        loaded: false,
        state: null,
        metadata: null,
      };
    }

    return {
      loaded: true,
      state: currentAgent.getState(),
      metadata: agentMetadata,
    };
  }),

  /**
   * Get Q-values for a given state
   */
  predict: publicProcedure
    .input(
      z.object({
        features: z.array(z.number()),
      })
    )
    .query(({ input }) => {
      if (!currentAgent) {
        throw new Error('No agent loaded');
      }

      const qValues = currentAgent.getQValues(input.features);
      const action = currentAgent.selectAction(input.features, false);

      return {
        action,
        actionName: actionToName(action),
        qValues: qValues.map((q) => ({
          action: q.action,
          actionName: actionToName(q.action),
          qValue: q.qValue,
        })),
        recommendation: getRecommendation(action, qValues),
      };
    }),

  /**
   * Backtest agent on provided candle data
   */
  backtest: publicProcedure
    .input(
      z.object({
        candles: z.array(
          z.object({
            timestamp: z.number(),
            open: z.number(),
            high: z.number(),
            low: z.number(),
            close: z.number(),
            volume: z.number(),
          })
        ),
        config: z
          .object({
            initialCapital: z.number().optional(),
            positionSize: z.number().optional(),
          })
          .optional(),
      })
    )
    .mutation(({ input }) => {
      if (!currentAgent) {
        throw new Error('No agent loaded');
      }

      const result = backtestAgent(
        currentAgent,
        input.candles as Candle[],
        input.config
      );

      // Store last result
      if (agentMetadata) {
        agentMetadata.lastBacktestResult = {
          timestamp: Date.now(),
          metrics: result.metrics,
          trades: result.trades.length,
        };
      }

      return {
        metrics: result.metrics,
        trades: result.trades,
        equityCurve: result.equityCurve,
        actions: result.actions.map((a) => ({
          ...a,
          actionName: actionToName(a.action as 0 | 1 | 2 | 3),
        })),
        portfolio: result.portfolio,
      };
    }),

  /**
   * Analyze current market state with agent
   */
  analyze: publicProcedure
    .input(
      z.object({
        candles: z.array(
          z.object({
            timestamp: z.number(),
            open: z.number(),
            high: z.number(),
            low: z.number(),
            close: z.number(),
            volume: z.number(),
          })
        ),
      })
    )
    .query(({ input }) => {
      if (!currentAgent) {
        throw new Error('No agent loaded');
      }

      // Build state from candles
      const env = new TradingEnvironment(input.candles as Candle[]);
      env.reset();

      // Step through to get to current state
      const maxSteps = Math.min(input.candles.length - 1, 1000);
      for (let i = 0; i < maxSteps - 1; i++) {
        env.step(Actions.HOLD);
      }

      const state = env.getState();
      const qValues = currentAgent.getQValues(state.features);
      const action = currentAgent.selectAction(state.features, false);

      return {
        state: {
          price: state.price,
          ict: state.ict,
          position: state.position,
          currentPrice: state.currentPrice,
        },
        prediction: {
          action,
          actionName: actionToName(action),
          qValues: qValues.map((q) => ({
            action: q.action,
            actionName: actionToName(q.action),
            qValue: q.qValue,
          })),
        },
        reasoning: generateReasoning(state, action, qValues),
      };
    }),

  /**
   * Load agent weights
   */
  loadWeights: publicProcedure
    .input(
      z.object({
        weights: z.array(
          z.object({
            shape: z.array(z.number()),
            data: z.array(z.number()),
          })
        ),
        config: z.object({
          inputSize: z.number(),
          hiddenLayers: z.array(z.number()),
          outputSize: z.number(),
          learningRate: z.number(),
          gamma: z.number(),
          tau: z.number(),
          epsilonStart: z.number(),
          epsilonEnd: z.number(),
          epsilonDecay: z.number(),
          dropout: z.number(),
          l2Regularization: z.number(),
        }),
        state: z.object({
          epsilon: z.number(),
          totalSteps: z.number(),
          episodeCount: z.number(),
          averageReward: z.number(),
          averageLoss: z.number(),
        }),
        agentType: z.literal('dqn'),
      })
    )
    .mutation(async ({ input }) => {
      // Create new agent with config
      currentAgent = new DQNAgent(input.config);

      // Load weights
      await currentAgent.loadWeights(input);

      agentMetadata = {
        createdAt: Date.now(),
        trainedEpisodes: input.state.episodeCount,
        lastBacktestResult: null,
      };

      return {
        success: true,
        state: currentAgent.getState(),
      };
    }),

  /**
   * Clear loaded agent
   */
  clear: publicProcedure.mutation(() => {
    if (currentAgent) {
      currentAgent.dispose();
      currentAgent = null;
      agentMetadata = null;
    }

    return { success: true };
  }),
});

// Helper functions
function getRecommendation(
  action: 0 | 1 | 2 | 3,
  qValues: { action: 0 | 1 | 2 | 3; qValue: number }[]
): string {
  const sorted = [...qValues].sort((a, b) => b.qValue - a.qValue);
  const best = sorted[0]!;
  const second = sorted[1]!;

  const confidence = best.qValue - second.qValue;
  const confidenceLevel =
    confidence > 0.5 ? 'high' : confidence > 0.2 ? 'medium' : 'low';

  const actionDesc = {
    0: 'Wait and observe',
    1: 'Enter long position',
    2: 'Enter short position',
    3: 'Close current position',
  }[action];

  return `${actionDesc} (${confidenceLevel} confidence)`;
}

function generateReasoning(
  state: { ict: unknown; price: unknown },
  action: 0 | 1 | 2 | 3,
  qValues: { action: 0 | 1 | 2 | 3; qValue: number }[]
): string[] {
  const reasons: string[] = [];
  const ict = state.ict as {
    bias: string;
    priceInBullishOB: boolean;
    priceInBearishOB: boolean;
    priceInBullishFVG: boolean;
    priceInBearishFVG: boolean;
    inKillZone: boolean;
    trendStrength: number;
  };

  // Market structure
  if (ict.bias === 'bullish') {
    reasons.push('Market structure is bullish');
  } else if (ict.bias === 'bearish') {
    reasons.push('Market structure is bearish');
  } else {
    reasons.push('Market structure is neutral/ranging');
  }

  // ICT concepts
  if (ict.priceInBullishOB) {
    reasons.push('Price is in a bullish order block');
  }
  if (ict.priceInBearishOB) {
    reasons.push('Price is in a bearish order block');
  }
  if (ict.priceInBullishFVG) {
    reasons.push('Price is in a bullish FVG');
  }
  if (ict.priceInBearishFVG) {
    reasons.push('Price is in a bearish FVG');
  }

  // Session
  if (ict.inKillZone) {
    reasons.push('Currently in a kill zone');
  }

  // Action reasoning
  const actionReasons = {
    0: 'No clear setup or waiting for better entry',
    1: 'Bullish confluence detected',
    2: 'Bearish confluence detected',
    3: 'Target reached or risk management triggered',
  };
  reasons.push(`Action: ${actionReasons[action]}`);

  // Confidence
  const sorted = [...qValues].sort((a, b) => b.qValue - a.qValue);
  const confidence = sorted[0]!.qValue - sorted[1]!.qValue;
  reasons.push(`Confidence margin: ${confidence.toFixed(3)}`);

  return reasons;
}
