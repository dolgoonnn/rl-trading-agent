import type { SimConfig } from './types';

/**
 * Maps a deployed strategy name to the exact SimConfig the live bot uses.
 * Fail-closed: throws on any unknown strategy rather than silently defaulting.
 */
export function resolveSimConfig(strategy: string): SimConfig {
  switch (strategy) {
    case 'order_block':
      return {
        entryTiming: 'signal_close',
        maxBars: 160,
        barMs: 3_600_000,
        exitMode: 'partial_tp',
        partialTP: { fraction: 0.50, triggerR: 1.41, beBuffer: 0.20 },
      };

    default:
      throw new Error(
        `resolveSimConfig: unknown strategy "${strategy}" — add it explicitly or check the strategy name`,
      );
  }
}
