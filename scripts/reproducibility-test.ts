#!/usr/bin/env npx tsx
/**
 * Iteration 0: Reproducibility Test
 *
 * Runs exp-014 config 5 times with different random seeds to test
 * whether the only passing model was real or lucky.
 *
 * Config (from exp-014):
 *   dropout=0.38, LR=0.00028, L2=0.028, epsilon=0.16, 120 episodes
 *
 * Usage:
 *   npx tsx scripts/reproducibility-test.ts
 *   npx tsx scripts/reproducibility-test.ts --runs 3   # fewer runs for testing
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ============================================
// Configuration
// ============================================

const args = process.argv.slice(2);

function getNumArg(name: string, defaultValue: number): number {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return parseFloat(args[idx + 1]!);
  }
  return defaultValue;
}

const NUM_RUNS = getNumArg('runs', 5);

// exp-014 config (the only passing config)
const EXP014_CONFIG = {
  dropout: 0.38,
  lr: 0.00028,
  l2: 0.028,
  epsilonEnd: 0.16,
  episodes: 120,
} as const;

// Different seeds for each run (deterministic but varied)
const SEEDS = [42, 137, 256, 512, 1024];

interface RunResult {
  run: number;
  seed: number;
  modelPath: string | null;
  btcSharpe: number;
  ethSharpe: number;
  solSharpe: number;
  aggregateWinRate: number;
  totalTrades: number;
  passed: boolean;
  failReasons: string[];
  valSharpe: number;
  durationMin: number;
}

// ============================================
// Logging
// ============================================

function log(message: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

// ============================================
// Main
// ============================================

async function main() {
  log('============================================================');
  log('ITERATION 0: REPRODUCIBILITY TEST');
  log('============================================================');
  log('');
  log(`Config (exp-014): dropout=${EXP014_CONFIG.dropout}, LR=${EXP014_CONFIG.lr}, L2=${EXP014_CONFIG.l2}, epsilon=${EXP014_CONFIG.epsilonEnd}`);
  log(`Runs: ${NUM_RUNS}`);
  log(`Seeds: ${SEEDS.slice(0, NUM_RUNS).join(', ')}`);
  log('');

  const results: RunResult[] = [];
  const startTime = Date.now();

  for (let run = 0; run < NUM_RUNS; run++) {
    const seed = SEEDS[run] ?? (run + 1) * 100;

    log('------------------------------------------------------------');
    log(`RUN ${run + 1}/${NUM_RUNS} (seed=${seed})`);
    log('------------------------------------------------------------');

    const runStart = Date.now();

    try {
      // Set seed via environment variable so train-iterative can pick it up
      const hypothesis = `Reproducibility test run ${run + 1}/${NUM_RUNS} (seed=${seed})`;

      // Run training
      const trainCmd = [
        'npx tsx scripts/train-iterative.ts',
        `--hypothesis "${hypothesis}"`,
        `--dropout ${EXP014_CONFIG.dropout}`,
        `--lr ${EXP014_CONFIG.lr}`,
        `--l2 ${EXP014_CONFIG.l2}`,
        `--epsilon-end ${EXP014_CONFIG.epsilonEnd}`,
        `--episodes ${EXP014_CONFIG.episodes}`,
        '--skip-gate', // We'll run the gate separately
      ].join(' ');

      log(`Running: ${trainCmd}`);

      const trainOutput = execSync(trainCmd, {
        encoding: 'utf-8',
        maxBuffer: 100 * 1024 * 1024,
        timeout: 30 * 60 * 1000, // 30 min timeout
        env: { ...process.env, REPRO_SEED: String(seed) },
        cwd: process.cwd(),
      });

      // Extract model path from training output
      const modelMatch = trainOutput.match(/Model: (models\/[^\s]+\.json)/);
      const valSharpeMatch = trainOutput.match(/Val Sharpe: ([\d.-]+)/);

      const modelPath = modelMatch?.[1] ?? null;
      const valSharpe = valSharpeMatch ? parseFloat(valSharpeMatch[1]!) : 0;

      if (!modelPath || !fs.existsSync(modelPath)) {
        log(`  Run ${run + 1}: No model produced`);
        results.push({
          run: run + 1,
          seed,
          modelPath: null,
          btcSharpe: 0,
          ethSharpe: 0,
          solSharpe: 0,
          aggregateWinRate: 0,
          totalTrades: 0,
          passed: false,
          failReasons: ['No model produced'],
          valSharpe: 0,
          durationMin: (Date.now() - runStart) / 1000 / 60,
        });
        continue;
      }

      log(`  Model saved: ${modelPath}`);
      log(`  Val Sharpe: ${valSharpe.toFixed(3)}`);

      // Run 90-day validation gate
      log('  Running 90-day gate...');
      try {
        const gateOutput = execSync(
          `npx tsx scripts/validate-90day.ts --model "${modelPath}" --json`,
          {
            encoding: 'utf-8',
            maxBuffer: 50 * 1024 * 1024,
            timeout: 15 * 60 * 1000,
          }
        );

        const gateResult = JSON.parse(gateOutput) as {
          symbols: Array<{ symbol: string; sharpe: number }>;
          aggregate: { avgWinRate: number; totalTrades: number };
          gate: { passed: boolean; failReasons: string[] };
        };

        const btcSharpe = gateResult.symbols.find(s => s.symbol === 'BTCUSDT')?.sharpe ?? 0;
        const ethSharpe = gateResult.symbols.find(s => s.symbol === 'ETHUSDT')?.sharpe ?? 0;
        const solSharpe = gateResult.symbols.find(s => s.symbol === 'SOLUSDT')?.sharpe ?? 0;

        const result: RunResult = {
          run: run + 1,
          seed,
          modelPath,
          btcSharpe,
          ethSharpe,
          solSharpe,
          aggregateWinRate: gateResult.aggregate.avgWinRate,
          totalTrades: gateResult.aggregate.totalTrades,
          passed: gateResult.gate.passed,
          failReasons: gateResult.gate.failReasons,
          valSharpe,
          durationMin: (Date.now() - runStart) / 1000 / 60,
        };

        results.push(result);

        const status = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
        log(`  Result: ${status}`);
        log(`  BTC=${btcSharpe.toFixed(2)} ETH=${ethSharpe.toFixed(2)} SOL=${solSharpe.toFixed(2)}`);
        log(`  WR=${gateResult.aggregate.avgWinRate.toFixed(1)}% Trades=${gateResult.aggregate.totalTrades}`);

      } catch (gateErr) {
        log(`  Gate failed: ${gateErr}`);
        results.push({
          run: run + 1,
          seed,
          modelPath,
          btcSharpe: 0,
          ethSharpe: 0,
          solSharpe: 0,
          aggregateWinRate: 0,
          totalTrades: 0,
          passed: false,
          failReasons: ['Gate validation script failed'],
          valSharpe,
          durationMin: (Date.now() - runStart) / 1000 / 60,
        });
      }

    } catch (err) {
      log(`  Training failed: ${err}`);
      results.push({
        run: run + 1,
        seed,
        modelPath: null,
        btcSharpe: 0,
        ethSharpe: 0,
        solSharpe: 0,
        aggregateWinRate: 0,
        totalTrades: 0,
        passed: false,
        failReasons: [`Training error: ${err}`],
        valSharpe: 0,
        durationMin: (Date.now() - runStart) / 1000 / 60,
      });
    }

    log('');
  }

  // ============================================
  // Summary
  // ============================================

  const totalDuration = (Date.now() - startTime) / 1000 / 60;
  const passCount = results.filter(r => r.passed).length;
  const btcSharpes = results.map(r => r.btcSharpe);
  const ethSharpes = results.map(r => r.ethSharpe);
  const solSharpes = results.map(r => r.solSharpe);

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = (arr: number[]) => {
    const m = mean(arr);
    return arr.reduce((a, x) => a + Math.pow(x - m, 2), 0) / arr.length;
  };

  log('============================================================');
  log('REPRODUCIBILITY TEST RESULTS');
  log('============================================================');
  log('');
  log(`Total runs: ${NUM_RUNS}`);
  log(`Pass rate: ${passCount}/${NUM_RUNS} (${((passCount / NUM_RUNS) * 100).toFixed(0)}%)`);
  log(`Total duration: ${totalDuration.toFixed(1)} minutes`);
  log('');
  log('Per-run results:');
  log('| Run | Seed | BTC Sharpe | ETH Sharpe | SOL Sharpe | WR%   | Trades | Status |');
  log('|-----|------|------------|------------|------------|-------|--------|--------|');

  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    log(`|  ${r.run}  | ${r.seed.toString().padStart(4)} | ${r.btcSharpe.toFixed(2).padStart(10)} | ${r.ethSharpe.toFixed(2).padStart(10)} | ${r.solSharpe.toFixed(2).padStart(10)} | ${r.aggregateWinRate.toFixed(1).padStart(5)} | ${r.totalTrades.toString().padStart(6)} | ${status.padStart(6)} |`);
  }

  log('');
  log('Variance analysis:');
  log(`  BTC Sharpe: mean=${mean(btcSharpes).toFixed(2)}, variance=${variance(btcSharpes).toFixed(2)}, std=${Math.sqrt(variance(btcSharpes)).toFixed(2)}`);
  log(`  ETH Sharpe: mean=${mean(ethSharpes).toFixed(2)}, variance=${variance(ethSharpes).toFixed(2)}, std=${Math.sqrt(variance(ethSharpes)).toFixed(2)}`);
  log(`  SOL Sharpe: mean=${mean(solSharpes).toFixed(2)}, variance=${variance(solSharpes).toFixed(2)}, std=${Math.sqrt(variance(solSharpes)).toFixed(2)}`);

  // Decision gate
  log('');
  if (passCount <= 1) {
    log('\x1b[31m============================================================\x1b[0m');
    log('\x1b[31m  CONCLUSION: FRAGILE - Validates pivot to rule-based system\x1b[0m');
    log('\x1b[31m============================================================\x1b[0m');
  } else if (passCount >= 3) {
    log('\x1b[32m============================================================\x1b[0m');
    log('\x1b[32m  CONCLUSION: RL signal may be real, but still proceed with\x1b[0m');
    log('\x1b[32m  rule-based system as parallel track\x1b[0m');
    log('\x1b[32m============================================================\x1b[0m');
  } else {
    log('\x1b[33m============================================================\x1b[0m');
    log('\x1b[33m  CONCLUSION: MIXED - Proceed with rule-based system\x1b[0m');
    log('\x1b[33m============================================================\x1b[0m');
  }

  // Write results to experiment file
  const experimentDoc = `# Iteration 0: Reproducibility Test

## Hypothesis
exp-014 (the only passing model out of 19 experiments) found a fragile local optimum, not a robust policy.

## Implementation Summary
- Ran exp-014 config ${NUM_RUNS} times with different random seeds
- Config: dropout=${EXP014_CONFIG.dropout}, LR=${EXP014_CONFIG.lr}, L2=${EXP014_CONFIG.l2}, epsilon=${EXP014_CONFIG.epsilonEnd}, ${EXP014_CONFIG.episodes} episodes
- Seeds: ${SEEDS.slice(0, NUM_RUNS).join(', ')}
- Each run trained independently and validated through 90-day gate

## Results

| Run | Seed | BTC Sharpe | ETH Sharpe | SOL Sharpe | WR% | Trades | Status |
|-----|------|------------|------------|------------|-----|--------|--------|
${results.map(r => `| ${r.run} | ${r.seed} | ${r.btcSharpe.toFixed(2)} | ${r.ethSharpe.toFixed(2)} | ${r.solSharpe.toFixed(2)} | ${r.aggregateWinRate.toFixed(1)} | ${r.totalTrades} | ${r.passed ? 'PASS' : 'FAIL'} |`).join('\n')}

### Variance Analysis
- **BTC Sharpe**: mean=${mean(btcSharpes).toFixed(2)}, std=${Math.sqrt(variance(btcSharpes)).toFixed(2)}
- **ETH Sharpe**: mean=${mean(ethSharpes).toFixed(2)}, std=${Math.sqrt(variance(ethSharpes)).toFixed(2)}
- **SOL Sharpe**: mean=${mean(solSharpes).toFixed(2)}, std=${Math.sqrt(variance(solSharpes)).toFixed(2)}

### Pass Rate: ${passCount}/${NUM_RUNS} (${((passCount / NUM_RUNS) * 100).toFixed(0)}%)

## Key Learnings
${passCount <= 1 ? '- CONFIRMED: exp-014 was lucky, not robust. The RL meta-strategy is fragile.\n- Small random seed changes destroy performance, confirming epsilon sensitivity finding.\n- Validates strategic pivot to rule-based confluence scorer.' : passCount >= 3 ? '- SURPRISING: RL signal appears real despite epsilon sensitivity.\n- Proceeding with rule-based system as primary, RL as potential optimizer.' : '- MIXED: Some runs pass but inconsistent.\n- Proceeding with rule-based system.'}

## Decision: ${passCount <= 1 ? 'Proceed to Iteration 1 (Walk-Forward) and Iteration 2 (Confluence Scorer)' : 'Proceed to rule-based system as primary track'}

## Impact on Next Iteration
- Walk-forward validation (Iteration 1) will replace static 90-day gate
- Rule-based confluence scorer (Iteration 2) will replace RL meta-strategy
- RL may return later (Iteration 7) as weight optimizer on top of proven base
`;

  const experimentPath = path.join('experiments', 'iteration-0-reproducibility.md');
  fs.writeFileSync(experimentPath, experimentDoc);
  log('');
  log(`Results saved to: ${experimentPath}`);

  // Save JSON results for programmatic access
  const jsonResults = {
    iteration: 0,
    title: 'Reproducibility Test',
    config: EXP014_CONFIG,
    runs: results,
    summary: {
      passCount,
      totalRuns: NUM_RUNS,
      passRate: passCount / NUM_RUNS,
      btcSharpe: { mean: mean(btcSharpes), variance: variance(btcSharpes) },
      ethSharpe: { mean: mean(ethSharpes), variance: variance(ethSharpes) },
      solSharpe: { mean: mean(solSharpes), variance: variance(solSharpes) },
    },
    conclusion: passCount <= 1 ? 'FRAGILE' : passCount >= 3 ? 'REAL_SIGNAL' : 'MIXED',
    totalDurationMin: totalDuration,
  };

  const jsonPath = path.join('experiments', 'iteration-0-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonResults, null, 2));
  log(`JSON results saved to: ${jsonPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
