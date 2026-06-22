#!/usr/bin/env tsx
/**
 * Crypto perpetual FUNDING / BASIS CARRY feasibility probe.
 *
 * GROUNDING (primary source):
 *   Schmeling, Schrimpf & Todorov, BIS Working Paper 1087 "Crypto carry" (2023).
 *   Carry strategy = SHORT a perpetual future + LONG the corresponding spot
 *   (delta-neutral cash-and-carry). The funding rate (settled ~3×/day) flows
 *   between longs and shorts to anchor the perp to spot; a short RECEIVES
 *   funding when the rate is positive. Documented average carry "above 10% p.a."
 *   ("approximately 8% with a low volatility of 0.8%" full-sample in the
 *   replication arXiv:2510.14435), peaks > 40% p.a. The paper interprets this as
 *   COMPENSATION FOR CRASH RISK, not free money: high carry predicts future
 *   price crashes.
 *   Replication (arXiv:2510.14435, Oct 2025): full sample (Aug-2020→May-2025)
 *   Sharpe 6.45; "Beginning in 2024, the Sharpe ratio falls to 4.06, and it
 *   turns negative in 2025" (ETF cash-and-carry arbitrage compressed funding).
 *
 * WHAT THIS PROBE TESTS (net-of-cost, on OUR 3 symbols, OUR window):
 *   The documented delta-neutral cash-and-carry. We replicate the spec exactly:
 *   long spot + short perp, harvest funding each crossed 00/08/16 UTC settlement
 *   via the canonical funding-ledger (zero sim/live mismatch). We charge:
 *     - taker fee + spread on BOTH legs at open AND close (4 fills total),
 *     - the realized funding flow itself (signed; short receives positive),
 *     - an optional periodic re-hedge cost for delta drift (default off; the
 *       basis trade is naturally delta-neutral so re-hedge is small).
 *   Two variants:
 *     A) ALWAYS-ON  — the structural BIS framing: hold the basis trade for the
 *        whole sample, harvest whatever funding settles (positive AND negative).
 *     B) THRESHOLD-GATED — only hold when the LAST SETTLED funding rate (strictly
 *        before the bar, no look-ahead) exceeds a breakeven-aware threshold;
 *        flat otherwise. This is the deployable "harvest only when it pays"
 *        version and the apples-to-apples successor to the prior funding-arb
 *        sleeve (graveyard: ~3.4%/yr on capital).
 *
 * NO LOOK-AHEAD: variant B decides in-market[t] from funding settled < t
 * (`lastSettledRateBefore`). The harvest itself is realized funding (known only
 * after it settles), credited over the held interval — never anticipated.
 *
 * COST MODEL (researched venue-realistic, Bybit-class):
 *   taker fee 5.5 bps/side, spread 2 bps (BTC) / 3 bps (ETH, SOL) per side.
 *   A full open+close of a TWO-leg position = 4 crossings ⇒ ~ (5.5+spread)×2 legs
 *   ×2 (open+close) bps round-trip. Variant A pays this ONCE (open at start,
 *   close at end). Variant B pays it on EVERY in→out cycle — that is exactly
 *   where the threshold version bleeds.
 *
 * Output: experiments/runs/funding-carry-results.json
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  carryHarvest,
  lastSettledRateBefore,
  type FundingPoint,
} from './lib/funding-carry-core';

const DATA = path.resolve(__dirname, '../data');
const HOUR = 3_600_000;
const SETTLEMENT_HOURS = [0, 8, 16] as const;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;

// Venue-realistic costs (bps), per side, per leg.
const TAKER_BPS = 5.5;
const SPREAD_BPS: Record<string, number> = { BTCUSDT: 2, ETHUSDT: 3, SOLUSDT: 3 };

interface FuturesBar { timestamp: number; fundingRate: number }

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function fmt(x: number, dp = 2): string { return x.toFixed(dp); }

/** Build the canonical settlement-grid funding series from forward-filled hourly futures bars. */
function loadFundingGrid(symbol: string): FundingPoint[] {
  const raw: FuturesBar[] = JSON.parse(
    fs.readFileSync(path.join(DATA, `${symbol}_futures_1h.json`), 'utf-8'),
  );
  const byTs = new Map<number, number>();
  for (const b of raw) byTs.set(b.timestamp, b.fundingRate);

  // Walk the canonical 00/08/16 UTC grid across the data span; take the rate
  // forward-filled into that exact hourly bar (the realized settled rate).
  const first = raw[0]!.timestamp;
  const last = raw[raw.length - 1]!.timestamp;
  const points: FundingPoint[] = [];
  let day = Math.floor(first / (24 * HOUR)) * 24 * HOUR;
  while (day <= last) {
    for (const h of SETTLEMENT_HOURS) {
      const t = day + h * HOUR;
      if (t >= first && t <= last) {
        const r = byTs.get(t);
        if (r !== undefined) points.push({ t, r });
      }
    }
    day += 24 * HOUR;
  }
  return points;
}

/** rateAt closure over a settlement grid. */
function rateAtFor(points: FundingPoint[]): (settlementMs: number) => number {
  const m = new Map(points.map((p) => [p.t, p.r]));
  return (t: number) => m.get(t) ?? 0;
}

interface VariantResult {
  symbol: string;
  variant: 'always_on' | 'threshold_gated';
  thresholdBps: number;
  cycles: number; // number of open→close round-trips (1 for always-on)
  settlementsHeld: number;
  totalSettlements: number;
  timeInMarketPct: number;
  grossFundingPct: number; // sum of harvested funding over capital, as % (no costs)
  costPct: number; // round-trip two-leg fees+spread, as % of capital
  netPct: number;
  netApyPct: number;
  grossApyPct: number;
  costShareOfGrossPct: number; // fraction of gross carry eaten by costs
  // risk: per-settlement net return series → annualized Sharpe (×√(3×365))
  netSharpe: number;
  // literature-comparable: net returns aggregated to DAILY, annualized ×√365.
  // The per-settlement Sharpe is inflated by the smoothness of 8h funding; the
  // daily Sharpe is the apples-to-apples number vs the published 6.45.
  netSharpeDaily: number;
  realizedVolAnnualPct: number; // annualized stdev of net returns (daily basis)
  maxDrawdownPct: number;
  years: number;
}

/** Aggregate a per-settlement series into per-UTC-day sums. */
function toDaily(points: FundingPoint[], perSettlement: number[]): number[] {
  const byDay = new Map<number, number>();
  for (let i = 0; i < points.length; i++) {
    const day = Math.floor(points[i]!.t / (24 * HOUR));
    byDay.set(day, (byDay.get(day) ?? 0) + perSettlement[i]!);
  }
  return [...byDay.values()];
}

/**
 * Run one variant on one symbol.
 *  - Capital normalised to 1.0 (returns are fraction of deployed notional on the
 *    spot leg; the perp short is the same notional, margined).
 *  - Round-trip cost of opening+closing the full two-leg position, in fraction:
 *    (taker+spread) per side × 2 legs × 2 (open+close).
 *  - Always-on: pay 1 round-trip (open at start, close at end), harvest every
 *    settlement (positive AND negative).
 *  - Threshold-gated: state machine in/out; pay a round-trip on every entry; only
 *    harvest while in-market. Signal = last settled rate strictly before t.
 */
function runVariant(
  symbol: string,
  points: FundingPoint[],
  variant: VariantResult['variant'],
  thresholdBps: number,
): VariantResult {
  const rateAt = rateAtFor(points);
  const roundTripCost = ((TAKER_BPS + SPREAD_BPS[symbol]!) / 1e4) * 2 /*legs*/ * 2; /*open+close*/
  const spanMs = points[points.length - 1]!.t - points[0]!.t;
  const years = spanMs / (365.25 * 24 * HOUR);

  // Per-settlement net return series for Sharpe / drawdown.
  const perSettlementNet: number[] = [];
  let cycles = 0;
  let settlementsHeld = 0;
  let grossFunding = 0;

  if (variant === 'always_on') {
    cycles = 1;
    // Harvest every settlement. The harvest for crossing settlement i is the
    // realized rate at i (short receives +r). Spread the single round-trip cost
    // onto the first settlement so the equity curve reflects entry friction.
    for (let i = 0; i < points.length; i++) {
      const r = points[i]!.r; // short receives +r
      grossFunding += r;
      settlementsHeld++;
      const costThis = i === 0 ? roundTripCost : 0;
      perSettlementNet.push(r - costThis);
    }
    // Audit: the inline harvest must equal the canonical funding-ledger result
    // over the full hold (entry just before first settlement → just after last).
    // This ties the script to the unit-tested `carryHarvest` primitive — zero
    // divergence from the live close path's settlement counting.
    const auditHarvest = carryHarvest(points[0]!.t - 1, points[points.length - 1]!.t, rateAt);
    if (Math.abs(auditHarvest - grossFunding) > 1e-9) {
      throw new Error(
        `funding-carry: always-on harvest audit failed for ${symbol}: ` +
          `inline=${grossFunding} ledger=${auditHarvest}`,
      );
    }
  } else {
    // Threshold-gated state machine.
    const thr = thresholdBps / 1e4;
    let inMarket = false;
    for (let i = 0; i < points.length; i++) {
      const t = points[i]!.t;
      // Decision uses funding settled STRICTLY before t (no look-ahead).
      const signal = lastSettledRateBefore(points, t);
      const wantIn = signal !== null && signal >= thr;

      let costThis = 0;
      if (wantIn && !inMarket) {
        // Enter at t: pay full two-leg round-trip up front (open + the eventual
        // close are both charged here, conservatively, so a 1-settlement hold is
        // fully costed).
        costThis += roundTripCost;
        cycles++;
        inMarket = true;
      } else if (!wantIn && inMarket) {
        inMarket = false; // exit cost already booked at entry
      }

      let harvestThis = 0;
      if (inMarket) {
        // We are holding across settlement i → realize its funding.
        harvestThis = rateAt(t); // == points[i].r; short receives +r
        grossFunding += harvestThis;
        settlementsHeld++;
      }
      perSettlementNet.push(harvestThis - costThis);
    }
  }

  // Single source of truth: net equity = Σ per-settlement net. Cost = gross − net.
  const net = perSettlementNet.reduce((s, x) => s + x, 0);
  const totalCostClean = grossFunding - net;
  const grossApy = years > 0 ? grossFunding / years : 0;
  const netApy = years > 0 ? net / years : 0;

  // Sharpe from per-settlement net returns, annualized by √(settlements/yr).
  const settlementsPerYear = points.length / years;
  const sd = std(perSettlementNet);
  const netSharpe = sd > 0 ? (mean(perSettlementNet) / sd) * Math.sqrt(settlementsPerYear) : 0;

  // Literature-comparable daily Sharpe + realized annual vol (the honest number).
  const daily = toDaily(points, perSettlementNet);
  const sdDaily = std(daily);
  const netSharpeDaily = sdDaily > 0 ? (mean(daily) / sdDaily) * Math.sqrt(365) : 0;
  const realizedVolAnnualPct = sdDaily * Math.sqrt(365) * 100;

  // Max drawdown on the cumulative net equity curve.
  let cum = 0, peak = 0, maxDD = 0;
  for (const x of perSettlementNet) {
    cum += x;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  }

  return {
    symbol,
    variant,
    thresholdBps,
    cycles,
    settlementsHeld,
    totalSettlements: points.length,
    timeInMarketPct: (settlementsHeld / points.length) * 100,
    grossFundingPct: grossFunding * 100,
    costPct: totalCostClean * 100,
    netPct: net * 100,
    netApyPct: netApy * 100,
    grossApyPct: grossApy * 100,
    costShareOfGrossPct: grossFunding > 0 ? (totalCostClean / grossFunding) * 100 : Infinity,
    netSharpe,
    netSharpeDaily,
    realizedVolAnnualPct,
    maxDrawdownPct: maxDD * 100,
    years,
  };
}

/** Year-by-year ALWAYS-ON net carry per symbol — tests the BIS/replication time-decay claim. */
function yearlyAlwaysOn(points: FundingPoint[]): Record<string, { grossApyPct: number; n: number }> {
  const byYear: Record<string, number[]> = {};
  for (const p of points) {
    const y = String(new Date(p.t).getUTCFullYear());
    (byYear[y] ||= []).push(p.r);
  }
  const out: Record<string, { grossApyPct: number; n: number }> = {};
  const perYear = 3 * 365; // settlements per year
  for (const [y, rs] of Object.entries(byYear)) {
    out[y] = { grossApyPct: mean(rs) * perYear * 100, n: rs.length };
  }
  return out;
}

function main(): void {
  console.log('='.repeat(72));
  console.log('CRYPTO FUNDING / BASIS CARRY — feasibility probe (BIS WP1087 spec)');
  console.log('='.repeat(72));
  console.log(`Cost model: taker ${TAKER_BPS}bps/side + spread {BTC:2, ETH:3, SOL:3}bps/side, charged on BOTH legs at open AND close.`);
  console.log('');

  const symbolResults: Record<string, {
    alwaysOn: VariantResult;
    gated: VariantResult[];
    yearly: Record<string, { grossApyPct: number; n: number }>;
  }> = {};

  const thresholds = [2, 5, 8, 12]; // bps/settlement gates (breakeven-aware sweep)

  for (const sym of SYMBOLS) {
    const points = loadFundingGrid(sym);
    const alwaysOn = runVariant(sym, points, 'always_on', 0);
    const gated = thresholds.map((thr) => runVariant(sym, points, 'threshold_gated', thr));
    const yearly = yearlyAlwaysOn(points);
    symbolResults[sym] = { alwaysOn, gated, yearly };

    console.log(`--- ${sym} (${points.length} settlements, ${fmt(alwaysOn.years, 2)}yr) ---`);
    console.log(`  ALWAYS-ON: gross ${fmt(alwaysOn.grossApyPct, 1)}%/yr → net ${fmt(alwaysOn.netApyPct, 1)}%/yr | costs ate ${fmt(alwaysOn.costShareOfGrossPct, 1)}% of gross | Sharpe(daily) ${fmt(alwaysOn.netSharpeDaily, 2)} | vol ${fmt(alwaysOn.realizedVolAnnualPct, 2)}%/yr | maxDD ${fmt(alwaysOn.maxDrawdownPct, 2)}%`);
    for (const g of gated) {
      console.log(`  GATE>${g.thresholdBps}bps: net ${fmt(g.netApyPct, 1)}%/yr | in-mkt ${fmt(g.timeInMarketPct, 1)}% | ${g.cycles} cycles | costs ate ${fmt(g.costShareOfGrossPct, 1)}% of gross | Sharpe ${fmt(g.netSharpe, 2)}`);
    }
    console.log(`  Year-by-year gross carry: ${Object.entries(yearly).map(([y, v]) => `${y}=${fmt(v.grossApyPct, 1)}%`).join(', ')}`);
    console.log('');
  }

  // Portfolio (equal-weight 3 symbols) always-on, settlement-aligned.
  // Build a unified per-settlement net series by averaging the three symbols at
  // each common settlement instant (ρ across symbols matters for the EW Sharpe).
  const grids = SYMBOLS.map((s) => loadFundingGrid(s));
  const tSet = new Set<number>();
  for (const g of grids) for (const p of g) tSet.add(p.t);
  const allTs = [...tSet].sort((a, b) => a - b);
  const maps = grids.map((g) => new Map(g.map((p) => [p.t, p.r])));
  const ewNet: number[] = [];
  // EW always-on: each symbol pays its own one-time round-trip on the first
  // common settlement; thereafter harvest the EW average funding.
  const rtCosts = SYMBOLS.map((s) => ((TAKER_BPS + SPREAD_BPS[s]!) / 1e4) * 2 * 2);
  const ewEntryCost = mean(rtCosts);
  for (let i = 0; i < allTs.length; i++) {
    const t = allTs[i]!;
    const present = maps.map((m) => m.get(t)).filter((r): r is number => r !== undefined);
    if (present.length === 0) { ewNet.push(0); continue; }
    const avgR = mean(present); // short receives +avgR
    ewNet.push(avgR - (i === 0 ? ewEntryCost : 0));
  }
  const ewYears = (allTs[allTs.length - 1]! - allTs[0]!) / (365.25 * 24 * HOUR);
  const ewSettlementsPerYear = allTs.length / ewYears;
  const ewGrossApy = mean(ewNet.map((x, i) => x + (i === 0 ? ewEntryCost : 0))) * ewSettlementsPerYear * 100;
  const ewNetApy = mean(ewNet) * ewSettlementsPerYear * 100;
  // Daily-aggregated EW Sharpe (literature-comparable).
  const ewPoints: FundingPoint[] = allTs.map((t) => ({ t, r: 0 }));
  const ewDaily = toDaily(ewPoints, ewNet);
  const ewSharpe = std(ewDaily) > 0 ? (mean(ewDaily) / std(ewDaily)) * Math.sqrt(365) : 0;
  const ewVolAnnualPct = std(ewDaily) * Math.sqrt(365) * 100;
  let cum = 0, peak = 0, ewDD = 0;
  for (const x of ewNet) { cum += x; peak = Math.max(peak, cum); ewDD = Math.max(ewDD, peak - cum); }

  console.log('--- EQUAL-WEIGHT 3-SYMBOL PORTFOLIO (always-on, settlement-aligned) ---');
  console.log(`  gross ${fmt(ewGrossApy, 1)}%/yr → net ${fmt(ewNetApy, 1)}%/yr | Sharpe(daily) ${fmt(ewSharpe, 2)} | vol ${fmt(ewVolAnnualPct, 2)}%/yr | maxDD ${fmt(ewDD, 2)}% | ${fmt(ewYears, 2)}yr`);
  console.log('');
  console.log('PUBLISHED COMPARISON (arXiv:2510.14435 replicating BIS WP1087, Aug2020–May2025):');
  console.log('  full-sample mean ~8%/yr, vol ~0.8%, Sharpe 6.45 → 2024 Sharpe 4.06 → 2025 NEGATIVE.');

  const out = {
    meta: {
      probe: 'crypto funding/basis carry feasibility (BIS WP1087 cash-and-carry spec)',
      date: new Date().toISOString().slice(0, 10),
      symbols: SYMBOLS,
      costModel: { takerBpsPerSide: TAKER_BPS, spreadBpsPerSide: SPREAD_BPS, chargedOn: 'both legs, open + close' },
      grounding: {
        primary: 'Schmeling, Schrimpf, Todorov — BIS Working Paper 1087 "Crypto carry" (2023)',
        replication: 'arXiv:2510.14435 "Cryptocurrency as an Investable Asset Class" (2025), §3.9',
        publishedFullSample: { meanApyPct: 8, volPct: 0.8, sharpe: 6.45, period: '2020-08..2025-05' },
        published2024Sharpe: 4.06,
        published2025: 'negative',
        interpretation: 'crash-risk premium; high carry predicts future crashes (not arbitrage profit)',
      },
    },
    perSymbol: symbolResults,
    portfolioEW: {
      grossApyPct: ewGrossApy,
      netApyPct: ewNetApy,
      netSharpeDaily: ewSharpe,
      realizedVolAnnualPct: ewVolAnnualPct,
      maxDrawdownPct: ewDD,
      years: ewYears,
      settlements: allTs.length,
    },
  };
  const outPath = path.resolve(__dirname, '../experiments/runs/funding-carry-results.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${outPath}`);
}

main();
