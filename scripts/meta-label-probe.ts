/**
 * Meta-label probe CLI — OOS AUC + top-quantile lift + gate verdict.
 *
 * Usage:
 *   npx tsx scripts/meta-label-probe.ts --features <path.json> \
 *     [--k 5] [--embargo 0.01] [--top-q 0.2] \
 *     [--iters 500] [--lr 0.1] [--l2 1.0]
 *
 * Input JSON: array of TradeFeatureRow (from --dump-features in backtest-confluence).
 * Output: human-readable probe report to stdout.
 *
 * This script is intentionally thin — all orchestration lives in runProbe()
 * (src/lib/meta/probe-core.ts) which is fully unit-tested.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runProbe } from '@/lib/meta/probe-core';
import type { TradeFeatureRow } from '@/lib/meta/dataset';

// ---------------------------------------------------------------------------
// Minimal arg parsing (no external deps)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  features: string;
  k: number;
  embargoFrac: number;
  topQ: number;
  iters: number;
  lr: number;
  l2: number;
} {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length - 1; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key !== undefined && val !== undefined && key.startsWith('--') && !val.startsWith('--')) {
      args[key.slice(2)] = val;
    }
  }

  const featuresPath = args['features'];
  if (featuresPath === undefined || featuresPath === '') {
    process.stderr.write('Error: --features <path> is required\n');
    process.exit(1);
  }

  return {
    features: featuresPath,
    k: Number(args['k'] ?? '5'),
    embargoFrac: Number(args['embargo'] ?? '0.01'),
    topQ: Number(args['top-q'] ?? '0.2'),
    iters: Number(args['iters'] ?? '500'),
    lr: Number(args['lr'] ?? '0.1'),
    l2: Number(args['l2'] ?? '1.0'),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  // Load feature dump.
  const absPath = path.resolve(opts.features);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`Error: file not found: ${absPath}\n`);
    process.exit(1);
  }

  let rows: TradeFeatureRow[];
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    rows = JSON.parse(raw) as TradeFeatureRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: failed to parse JSON: ${msg}\n`);
    process.exit(1);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    process.stderr.write('Error: features file must be a non-empty JSON array\n');
    process.exit(1);
  }

  // Run probe — all logic lives in the pure runProbe() function.
  const result = runProbe(rows, {
    k: opts.k,
    embargoFrac: opts.embargoFrac,
    topQ: opts.topQ,
    logistic: {
      iterations: opts.iters,
      learningRate: opts.lr,
      l2: opts.l2,
    },
  });

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  const pct = (v: number, d = 1): string => `${(v * 100).toFixed(d)}%`;
  const fmt = (v: number, d = 4): string => v.toFixed(d);

  const lines: string[] = [
    '',
    '══════════════════════════════════════════════════════',
    '  Meta-Label Probe — Stage 1 OOS Report',
    '══════════════════════════════════════════════════════',
    '',
    '  Dataset',
    `    n               : ${result.n}`,
    `    base rate       : ${pct(result.baseRate)} (${Math.round(result.baseRate * result.n)}/${result.n} wins)`,
    '',
    '  Cross-validation',
    `    k               : ${result.k}`,
    `    embargo frac    : ${result.embargoFrac}`,
    `    mean train size : ${fmt(result.meanTrainSize, 1)} (after purge)`,
    `    mean test size  : ${fmt(result.meanTestSize, 1)}`,
    `    mean purged     : ${fmt(result.meanPurgedCount, 1)} (leakage-discipline signal)`,
    '',
    '  Logistic regression',
    `    iterations      : ${opts.iters}`,
    `    learning rate   : ${opts.lr}`,
    `    L2              : ${opts.l2}`,
    '',
    '  OOS metrics (all folds combined)',
    `    OOS AUC         : ${fmt(result.auc)}`,
    `    Top-${pct(result.topQ, 0)} lift  : ${fmt(result.lift)} (top-quantile win-rate vs base rate)`,
    '',
    '  Gate',
    `    Condition       : AUC > 0.55 AND lift > 0`,
    `    Verdict         : ${result.passed ? '✓ PASS' : '✗ FAIL — honest negative (no OOS signal)'}`,
    '',
  ];

  // One-line interpretation.
  let interpretation: string;
  if (result.auc > 0.7) {
    interpretation = `AUC ${fmt(result.auc, 2)} ⇒ real OOS predictive lift; proceed to Stage 2.`;
  } else if (result.auc > 0.55) {
    interpretation = `AUC ${fmt(result.auc, 2)} ⇒ weak OOS signal; monitor closely before Stage 2.`;
  } else {
    interpretation = `AUC ${fmt(result.auc, 2)} ⇒ no OOS signal; do NOT proceed to Stage 2.`;
  }

  lines.push(`  Interpretation: ${interpretation}`);
  lines.push('');
  lines.push('══════════════════════════════════════════════════════');
  lines.push('');

  process.stdout.write(lines.join('\n'));

  // Per-fold breakdown (compact).
  process.stdout.write('  Fold breakdown:\n');
  result.foldStats.forEach((f, idx) => {
    process.stdout.write(
      `    Fold ${idx + 1}: train=${f.trainSize}  test=${f.testSize}  purged=${f.purgedCount}\n`,
    );
  });
  process.stdout.write('\n');

  // Exit 1 on FAIL so CI pipelines can gate on this.
  if (!result.passed) {
    process.exit(1);
  }
}

main();
