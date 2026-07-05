/**
 * Startup exchange-position reconciliation.
 *
 * On restart the bot trusts its SQLite shadow book. If the exchange state
 * diverged while the bot was down — a stop/TP fired, a fill landed but wasn't
 * persisted, or someone traded the account manually — the shadow book is a
 * GHOST and the bot will manage a position that no longer exists, or ignore a
 * live one it doesn't know about.
 *
 * This module is the pure classifier: given the shadow position (or null) and
 * the confirmed exchange size (or null = UNKNOWN), it returns the divergence
 * state and the SAFE recommended action. The wiring in run-bot alerts and, for
 * dangerous states, latches new-entry halt — it never auto-opens or silently
 * adopts an unknown live position.
 *
 * Only meaningful in live mode (real keys). In paper/disabled mode getOpenSize
 * confirms flat, so the only reachable non-sync state is DB_GHOST (a stale
 * shadow row), which is still worth catching.
 */

export type ReconcileState =
  | 'IN_SYNC'
  | 'DB_GHOST' // shadow holds, venue confirmed flat → venue closed it while we were down
  | 'EXCHANGE_ORPHAN' // shadow flat, venue holds → unmanaged live position, unknown stops
  | 'SIZE_MISMATCH' // both hold but notionals diverge beyond tolerance
  | 'UNKNOWN'; // venue state could not be confirmed, or shadow un-verifiable

export type ReconcileAction =
  | 'none'
  | 'close_shadow' // book the missed exit on the shadow book (no exchange call)
  | 'keep_managing' // can't confirm flat → keep managing the shadow position
  | 'alert' // surface to operator, no state change
  | 'halt_and_alert'; // latch new-entry halt + operator review required

export interface StartupReconcileInput {
  /** The shadow (DB) open position for a symbol, or null if the book is flat. */
  shadow: {
    symbol: string;
    direction: 'long' | 'short';
    positionSizeUSDT: number;
    entryPrice: number;
  } | null;
  /**
   * Confirmed exchange position from ExchangeExitManager.getOpenSize: `{ size }`
   * in base units (0 = CONFIRMED flat), or `null` when the venue state is
   * UNKNOWN (API error). Never trust a fabricated 0.
   */
  exchange: { size: number; avgPrice: number } | null;
  /** Relative notional tolerance for size matching (default 5%). */
  sizeTolerance?: number;
}

export interface ReconcileDecision {
  state: ReconcileState;
  action: ReconcileAction;
  reason: string;
}

const DEFAULT_SIZE_TOLERANCE = 0.05;

export function decideStartupReconcile(input: StartupReconcileInput): ReconcileDecision {
  const { shadow, exchange, sizeTolerance = DEFAULT_SIZE_TOLERANCE } = input;

  // Venue state UNKNOWN — fail closed. Never act on an unconfirmed flat.
  if (exchange === null) {
    return shadow
      ? {
          state: 'UNKNOWN',
          action: 'keep_managing',
          reason: 'Exchange state UNKNOWN (API error); shadow holds a position — keep managing it, do not close on an unconfirmed flat.',
        }
      : {
          state: 'UNKNOWN',
          action: 'alert',
          reason: 'Exchange state UNKNOWN (API error) and shadow is flat — cannot confirm no orphan position exists; alert operator.',
        };
  }

  const venueHolds = exchange.size > 0;

  // Both flat → clean.
  if (!shadow && !venueHolds) {
    return { state: 'IN_SYNC', action: 'none', reason: 'Both shadow book and exchange are flat.' };
  }

  // Shadow flat, venue holds → orphan.
  if (!shadow && venueHolds) {
    return {
      state: 'EXCHANGE_ORPHAN',
      action: 'halt_and_alert',
      reason: `Exchange holds an unmanaged position (size ${exchange.size}) the bot has no shadow record of — unknown stops. Halt new entries; operator must adopt or flatten it.`,
    };
  }

  // Shadow holds, venue flat → ghost.
  if (shadow && !venueHolds) {
    return {
      state: 'DB_GHOST',
      action: 'close_shadow',
      reason: `Shadow book holds ${shadow.symbol} ${shadow.direction} but exchange is confirmed flat — the venue closed it (stop/TP/manual) while the bot was down. Book the missed exit.`,
    };
  }

  // Both hold → verify size. shadow is non-null here.
  if (!(shadow!.entryPrice > 0)) {
    return {
      state: 'UNKNOWN',
      action: 'keep_managing',
      reason: `Cannot compute expected base size for ${shadow!.symbol} (entryPrice=${shadow!.entryPrice}); keep managing the shadow position without a size claim.`,
    };
  }
  const expectedBaseSize = shadow!.positionSizeUSDT / shadow!.entryPrice;
  const drift = Math.abs(exchange.size - expectedBaseSize) / expectedBaseSize;
  if (drift > sizeTolerance) {
    return {
      state: 'SIZE_MISMATCH',
      action: 'halt_and_alert',
      reason: `Size mismatch on ${shadow!.symbol}: exchange ${exchange.size} vs expected ~${expectedBaseSize.toFixed(6)} (${(drift * 100).toFixed(1)}% drift). Halt new entries; operator review.`,
    };
  }

  return {
    state: 'IN_SYNC',
    action: 'none',
    reason: `Shadow and exchange agree on ${shadow!.symbol} (size ~${expectedBaseSize.toFixed(6)}, ${(drift * 100).toFixed(1)}% drift).`,
  };
}

/** Operator triage severity for an alert channel. */
export function reconcileSeverity(state: ReconcileState): 'info' | 'warn' | 'critical' {
  switch (state) {
    case 'IN_SYNC':
      return 'info';
    case 'DB_GHOST':
      return 'warn';
    case 'EXCHANGE_ORPHAN':
    case 'SIZE_MISMATCH':
    case 'UNKNOWN':
      return 'critical';
  }
}
