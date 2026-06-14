#!/usr/bin/env npx tsx
/**
 * PROBE (Task 8 / plan Task 7) — charge funding as a REAL cost and re-confirm Run-20.
 *
 * Does the deployed Run-20 crypto edge survive once perpetual funding is debited at
 * every crossed 00:00/08:00/16:00 UTC settlement? This is an honest survival test,
 * not a tuning exercise: if the edge collapses we report it and flag Run-20 for
 * re-opening — we do NOT patch or re-fit to rescue it.
 *
 * GROUNDING (web-verified 2026-06-14): Bybit/Binance USDT perpetual funding settles
 * 3×/day at 00:00, 08:00, 16:00 UTC; a position pays/receives ONLY if open at the
 * settlement instant; when the rate is POSITIVE, LONGS pay shorts. We charge the
 * realized rate at each crossed settlement (half-open (entry,exit], no proration)
 * via the shared funding-ledger keystone.
 *
 * METHOD: spawn the EXACT Run-20 backtest twice as a subprocess (zero sim mismatch) —
 * once GROSS (no funding) and once NET (--charge-funding) — on BTCUSDT,ETHUSDT,SOLUSDT,
 * parse the JSON, and compare against the published Run-20 GROSS figure
 * (69.7% WF / +1573.7% PnL / 48.5% WR).
 *
 * GATE: WF pass-rate stays > 60% AND net full-sample PnL clearly positive.
 *
 * Output: experiments/runs/funding-cost-run20.json  +  experiments/funding-cost.md
 *
 * Usage: npx tsx scripts/research-funding-cost.ts
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---- Published Run-20 GROSS baseline (MEMORY.md) ----
const PUBLISHED = { wfPassRate: 0.697, pnlPct: 1573.7, winRate: 48.5 };
const GATE_WF_MIN = 0.6;

const SYMBOLS = 'BTCUSDT,ETHUSDT,SOLUSDT';

// ---- The EXACT Run-20 config (MEMORY.md), as backtest-confluence CLI args ----
const RUN20_ARGS: string[] = [
  '--strategy', 'ob',
  '--sl-mode', 'dynamic_rr',
  '--friction', '0.0007',
  '--suppress-regime', 'ranging+normal,ranging+high,downtrend+high',
  '--threshold', '4.048',
  '--exit-mode', 'simple',
  '--partial-tp', '0.50,1.41,0.20',
  '--atr-extension', '5.79',
  '--ob-half-life', '12',
  '--max-bars', '160',
  '--cooldown-bars', '7',
  '--regime-threshold',
  'uptrend+high:3.14,uptrend+normal:5.74,uptrend+low:5.49,downtrend+normal:4.38,downtrend+low:6.50',
  '--weights',
  'structureAlignment:0.1928,killZoneActive:1.2658,liquiditySweep:1.4896,obProximity:2.7262,fvgAtCE:2.3162,recentBOS:2.2229,rrRatio:0.5567,oteZone:1.0621,obFvgConfluence:1.0892,momentumConfirmation:0.0000',
  '--symbols', SYMBOLS,
];

// ---- Minimal shape of the backtest JSON we read ----
interface BacktestJson {
  walkForwardResult: {
    passRate: number;
    overallPassed: boolean;
    symbols: { symbol: string; positiveWindows: number; totalWindows: number; passed: boolean }[];
  };
  totalTrades: number;
  overallWinRate: number;
  overallPnl: number;
  fundingStats?: {
    enabled: boolean;
    totalFundingReturn: number;
    settlementsCrossed: number;
    tradesWithFunding: number;
    sumGrossPnl: number;
    sumNetPnl: number;
  };
}

/** The probe's emitted result shape (also the markdown writer's input). */
interface ProbeResult {
  probe: string;
  generatedAt: string;
  grounding: { source: string; mechanism: string; verifiedAt: string };
  config: { run: string; symbols: string[]; cliArgs: string[] };
  published: typeof PUBLISHED;
  gross: { wfPassRate: number; pnlPct: number; winRate: number; totalTrades: number; perSymbol: unknown };
  net: { wfPassRate: number; pnlPct: number; winRate: number; totalTrades: number; perSymbol: unknown };
  funding: {
    totalFundingReturn: number;
    totalFundingPaidPct: number;
    settlementsCrossed: number;
    tradesWithFunding: number;
    meanSettlementsPerTrade: number;
    meanFundingDragBpsPerTrade: number;
    fundingPctOfGross: number;
  };
  deltas: { wfPassRateDelta: number; pnlPctDelta: number; winRateDelta: number };
  gate: { criterion: string; netWfPassRate: number; netPnlPositive: boolean; verdict: string };
}

/**
 * Run the backtest as a subprocess and parse its JSON output.
 *
 * The child redirects its stdout to a temp FILE via the shell (not a pipe): the
 * backtest calls `process.exit(1)` when WF does not pass, which can truncate a
 * captured stdout pipe before it flushes. A file redirect is durable, so we read
 * the complete JSON back regardless of the child's exit code.
 */
function runBacktest(extraArgs: string[]): BacktestJson {
  const outFile = path.join(os.tmpdir(), `funding-probe-${process.pid}-${Date.now()}.json`);
  const cmd = ['npx', 'tsx', 'scripts/backtest-confluence.ts', ...RUN20_ARGS, '--json', ...extraArgs]
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ');
  const r = spawnSync('sh', ['-c', `${cmd} > '${outFile}' 2>/dev/null`], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });
  let raw = '';
  try {
    raw = fs.readFileSync(outFile, 'utf-8');
  } finally {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  }
  const start = raw.indexOf('{');
  if (start < 0) {
    throw new Error(`No JSON object found in backtest output (exit=${r.status}).`);
  }
  return JSON.parse(raw.slice(start)) as BacktestJson;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function main(): void {
  console.log('[funding-PROBE] Running Run-20 GROSS (no funding) ...');
  const gross = runBacktest([]);
  console.log(
    `  gross: WF=${pct(gross.walkForwardResult.passRate)}  PnL=${(gross.overallPnl * 100).toFixed(1)}%  WR=${gross.overallWinRate.toFixed(1)}%  trades=${gross.totalTrades}`,
  );

  console.log('[funding-PROBE] Running Run-20 NET (--charge-funding) ...');
  const net = runBacktest(['--charge-funding']);
  console.log(
    `  net:   WF=${pct(net.walkForwardResult.passRate)}  PnL=${(net.overallPnl * 100).toFixed(1)}%  WR=${net.overallWinRate.toFixed(1)}%  trades=${net.totalTrades}`,
  );

  const fs_ = net.fundingStats;
  if (!fs_ || !fs_.enabled) throw new Error('NET run did not return fundingStats — wiring broke');

  // Mean funding drag per trade in bps (signed: negative = net cost to the book).
  const meanFundingDragBps = net.totalTrades > 0 ? (fs_.totalFundingReturn / net.totalTrades) * 1e4 : 0;
  // Total funding "paid" as a fraction of notional (positive number = cost magnitude).
  const totalFundingPaidPct = -fs_.totalFundingReturn * 100;
  const meanSettlementsPerTrade = net.totalTrades > 0 ? fs_.settlementsCrossed / net.totalTrades : 0;
  // Funding as a share of gross per-trade-sum PnL (how big a bite funding takes).
  const fundingPctOfGross = fs_.sumGrossPnl !== 0 ? Math.abs(fs_.totalFundingReturn) / Math.abs(fs_.sumGrossPnl) : 0;

  const netWfPass = net.walkForwardResult.passRate;
  const netPnlPositive = net.overallPnl > 0;
  const gatePass = netWfPass > GATE_WF_MIN && netPnlPositive;

  const result: ProbeResult = {
    probe: 'funding-cost-run20',
    generatedAt: new Date().toISOString(),
    grounding: {
      source: 'Bybit Help Center — Introduction to Funding Rate / Perpetual Futures Contract Fees Explained',
      mechanism:
        'Funding settles 3x/day at 00:00/08:00/16:00 UTC; only positions open at the settlement instant pay/receive; positive rate ⇒ longs pay shorts.',
      verifiedAt: '2026-06-14',
    },
    config: { run: 'Run-20', symbols: SYMBOLS.split(','), cliArgs: RUN20_ARGS },
    published: PUBLISHED,
    gross: {
      wfPassRate: gross.walkForwardResult.passRate,
      pnlPct: gross.overallPnl * 100,
      winRate: gross.overallWinRate,
      totalTrades: gross.totalTrades,
      perSymbol: gross.walkForwardResult.symbols,
    },
    net: {
      wfPassRate: net.walkForwardResult.passRate,
      pnlPct: net.overallPnl * 100,
      winRate: net.overallWinRate,
      totalTrades: net.totalTrades,
      perSymbol: net.walkForwardResult.symbols,
    },
    funding: {
      totalFundingReturn: fs_.totalFundingReturn,
      totalFundingPaidPct,
      settlementsCrossed: fs_.settlementsCrossed,
      tradesWithFunding: fs_.tradesWithFunding,
      meanSettlementsPerTrade,
      meanFundingDragBpsPerTrade: meanFundingDragBps,
      fundingPctOfGross,
    },
    deltas: {
      wfPassRateDelta: net.walkForwardResult.passRate - gross.walkForwardResult.passRate,
      pnlPctDelta: (net.overallPnl - gross.overallPnl) * 100,
      winRateDelta: net.overallWinRate - gross.overallWinRate,
    },
    gate: {
      criterion: 'net WF pass-rate > 60% AND net full-sample PnL clearly positive',
      netWfPassRate: netWfPass,
      netPnlPositive,
      verdict: gatePass ? 'PASS' : 'FAIL',
    },
  };

  const outJson = path.join(process.cwd(), 'experiments', 'runs', 'funding-cost-run20.json');
  fs.writeFileSync(outJson, JSON.stringify(result, null, 2));
  console.log(`\n[funding-PROBE] wrote ${outJson}`);

  // ---- Console verdict ----
  console.log('\n================ FUNDING-COST PROBE — Run-20 ================');
  console.log(`Published GROSS:  WF=${pct(PUBLISHED.wfPassRate)}  PnL=+${PUBLISHED.pnlPct}%  WR=${PUBLISHED.winRate}%`);
  console.log(`Measured GROSS:   WF=${pct(gross.walkForwardResult.passRate)}  PnL=${(gross.overallPnl * 100).toFixed(1)}%  WR=${gross.overallWinRate.toFixed(1)}%`);
  console.log(`Measured NET:     WF=${pct(net.walkForwardResult.passRate)}  PnL=${(net.overallPnl * 100).toFixed(1)}%  WR=${net.overallWinRate.toFixed(1)}%`);
  console.log(`Funding drag:     ${meanFundingDragBps.toFixed(2)} bps/trade  |  ${meanSettlementsPerTrade.toFixed(1)} settlements/trade  |  funding=${(fundingPctOfGross * 100).toFixed(1)}% of gross`);
  console.log(`GATE (WF>60% AND net PnL>0): ${result.gate.verdict}`);
  console.log('=============================================================\n');

  writeMarkdown(result, gatePass);

  if (!gatePass) {
    console.log('VERDICT: FAIL — Run-20 is flagged for re-opening. NOT patched (project canon: a falsified strategy that surfaces a mechanism is a win).');
  } else {
    console.log('VERDICT: PASS — Run-20 survives funding as a real cost (full-sample). WF remains the live gate.');
  }
}

function writeMarkdown(r: ProbeResult, gatePass: boolean): void {
  const f = r.funding;
  const md = `# Funding-Cost PROBE — Does Run-20 survive funding charged as a real cost?

**Status:** ${gatePass ? 'PASS (survives, queued for WF re-confirm at review)' : 'FAIL — Run-20 flagged for RE-OPENING'}
**Date:** ${r.generatedAt.slice(0, 10)}
**Probe:** \`scripts/research-funding-cost.ts\` → \`experiments/runs/funding-cost-run20.json\`

## Grounding (mechanism)

${r.grounding.mechanism} (Bybit Help Center, verified ${r.grounding.verifiedAt}.) Sources: Bybit "Introduction to Funding Rate" and "Perpetual Futures Contract Fees Explained".

We charge the **realized** funding rate at **each** crossed 00:00/08:00/16:00 UTC settlement in the half-open interval \`(entry, exit]\` — no proration of partial periods — via the shared funding-ledger keystone (\`src/lib/cost/funding-ledger.ts\`), the same signed rule the live \`closePosition\` path uses (zero sim/live mismatch). Sign convention: a **long in positive funding pays** (negative funding return); a short receives. On these three symbols funding is positive at ~89% of settlements (mean ~+0.74 bps/settlement), so a long-biased OB book is structurally a funding **payer**.

## Gross vs Net (Run-20, BTCUSDT/ETHUSDT/SOLUSDT, full sample)

| Metric | Published GROSS | Measured GROSS | Measured NET (funding charged) | Δ (net − gross) |
|---|---|---|---|---|
| WF pass-rate | ${pct(r.published.wfPassRate)} | ${pct(r.gross.wfPassRate)} | **${pct(r.net.wfPassRate)}** | ${(r.deltas.wfPassRateDelta * 100).toFixed(1)} pp |
| Full-sample PnL | +${r.published.pnlPct}% | ${r.gross.pnlPct.toFixed(1)}% | **${r.net.pnlPct.toFixed(1)}%** | ${r.deltas.pnlPctDelta.toFixed(1)} pp |
| Win rate | ${r.published.winRate}% | ${r.gross.winRate.toFixed(1)}% | ${r.net.winRate.toFixed(1)}% | ${r.deltas.winRateDelta.toFixed(2)} pp |
| Trades | — | ${r.gross.totalTrades} | ${r.net.totalTrades} | — |

> The measured-gross row may differ slightly from the published figure because the data window has been refreshed since Run-20 was frozen (MEMORY notes Run-20 reads 64.9% WF on refreshed data). The honest comparison is **measured gross → measured net on the same data**.

## Funding drag

- **Mean funding drag:** ${f.meanFundingDragBpsPerTrade.toFixed(2)} bps per trade (signed; negative = the book pays).
- **Settlements crossed:** ${f.settlementsCrossed} total, ${f.meanSettlementsPerTrade.toFixed(1)} per trade (mean hold spans ~${f.meanSettlementsPerTrade.toFixed(1)} funding windows).
- **Total funding paid:** ${f.totalFundingPaidPct.toFixed(3)}% of notional summed across all trades.
- **Funding as a share of gross:** ${(f.fundingPctOfGross * 100).toFixed(1)}% of the per-trade-sum gross PnL.
- ${f.tradesWithFunding} of ${r.net.totalTrades} trades crossed at least one settlement.

## Verdict vs the GATE

**Gate:** net WF pass-rate **> 60%** AND net full-sample PnL clearly positive.

- Net WF pass-rate: **${pct(r.gate.netWfPassRate)}** ${r.gate.netWfPassRate > 0.6 ? '(> 60% ✓)' : '(≤ 60% ✗)'}
- Net full-sample PnL positive: **${r.gate.netPnlPositive ? 'yes ✓' : 'no ✗'}**
- **VERDICT: ${r.gate.verdict}**

${gatePass
      ? 'Run-20 survives funding charged as a real cost on the full sample. Funding is a measurable but non-fatal drag. Queue a funding-net **walk-forward re-confirm** at the next review before trusting bot sizing.'
      : '**Run-20 is RE-OPENED.** It does not clear the funding-net gate. Per project canon we do NOT patch or re-fit to rescue it — the mechanism this surfaces (a long-biased OB book is a structural funding payer in a persistently positive-funding regime) is the win. The fix is a re-optimization that prices funding in from the start, decided at the review cycle, not here.'}

## Is the funding entry-FILTER now redundant?

The confluence scorer carries a funding entry-filter (\`fundingMaxForLong\` / \`fundingMinForShort\`) that rejects longs when funding is "too positive". Once funding is a **real per-settlement cost** in the PnL, that filter is **no longer a free hard gate** — it would be **double-counting** the funding signal if both are active and tuned together: the cost already penalizes holding longs through positive-funding settlements, so the filter should be re-evaluated as an *expected-cost-vs-edge* trade-off, not an independent reject. Run-20 ships with the filter **disabled** (\`fundingMaxForLong=Infinity\`), so there is no double-count in the deployed config today — but any future re-fit that prices funding in must treat the filter and the cost as the **same** signal and not stack them.

## Files

- \`src/lib/cost/trade-cost.ts\` — pure funding-charge + maker/taker split helpers (wraps the ledger).
- \`scripts/backtest-confluence.ts\` — \`--charge-funding\`, \`--maker-bps\`, \`--taker-bps\` (all default OFF; gross path unchanged).
- \`scripts/research-funding-cost.ts\` — this PROBE.
- \`tests/cost/backtest-funding-debit.test.ts\` — TDD unit (funding sign/boundary/no-proration + maker/taker split).
`;

  const outMd = path.join(process.cwd(), 'experiments', 'funding-cost.md');
  fs.writeFileSync(outMd, md);
  console.log(`[funding-PROBE] wrote ${outMd}`);
}

main();
