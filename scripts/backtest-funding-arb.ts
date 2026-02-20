#!/usr/bin/env npx tsx
/**
 * Backtest Funding Rate Arbitrage
 *
 * Simulates the funding arb strategy on historical data.
 * Uses existing _futures_1h.json files (forward-filled 8h funding rates)
 * or synced _funding_rates.json files for higher accuracy.
 *
 * Assumptions:
 *   - Perfect hedging (delta-neutral, no directional P&L)
 *   - Configurable spread cost per entry/exit
 *   - Settlement occurs every 8h (00:00, 08:00, 16:00 UTC)
 *
 * Usage:
 *   npx tsx scripts/backtest-funding-arb.ts
 *   npx tsx scripts/backtest-funding-arb.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT
 *   npx tsx scripts/backtest-funding-arb.ts --min-rate 0.0003
 *   npx tsx scripts/backtest-funding-arb.ts --spread 0.0002
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================
// Types
// ============================================

interface FundingRecord {
  timestamp: number;
  fundingRate: number;
  fundingRateTimestamp?: number;
}

interface FuturesRecord {
  timestamp: number;
  fundingRate: number;
}

interface ArbTrade {
  symbol: string;
  direction: 'short_perp' | 'long_perp';
  entryTimestamp: number;
  exitTimestamp: number;
  entryFundingRate: number;
  holdTimeHours: number;
  fundingPayments: number;
  totalFundingCollected: number;
  spreadCost: number;
  netPnl: number;
  annualizedAPY: number;
  exitReason: string;
}

interface BacktestConfig {
  symbols: string[];
  minFundingRate: number;
  closeBelowRate: number;
  positionSizeUSDT: number;
  maxHoldTimeHours: number;
  commissionPerSide: number;
  spreadAssumption: Record<string, number>;
  maxArbPositions: number;
}

// ============================================
// Parse CLI args
// ============================================

function parseArgs(): BacktestConfig {
  const args = process.argv.slice(2);
  const config: BacktestConfig = {
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    minFundingRate: 0.0002,
    closeBelowRate: 0.00005,
    positionSizeUSDT: 2000,
    maxHoldTimeHours: 168,
    commissionPerSide: 0.00055,
    spreadAssumption: {
      BTCUSDT: 0.0002,
      ETHUSDT: 0.0003,
      SOLUSDT: 0.0003,
    },
    maxArbPositions: 3,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--symbols':
        config.symbols = args[++i]!.split(',');
        break;
      case '--min-rate':
        config.minFundingRate = parseFloat(args[++i]!);
        break;
      case '--close-rate':
        config.closeBelowRate = parseFloat(args[++i]!);
        break;
      case '--size':
        config.positionSizeUSDT = parseFloat(args[++i]!);
        break;
      case '--spread':
        {
          const s = parseFloat(args[++i]!);
          for (const sym of config.symbols) {
            config.spreadAssumption[sym] = s;
          }
        }
        break;
      case '--max-hold':
        config.maxHoldTimeHours = parseFloat(args[++i]!);
        break;
    }
  }

  return config;
}

// ============================================
// Data Loading
// ============================================

function loadFundingData(symbol: string): FundingRecord[] {
  const dataDir = path.resolve(__dirname, '../data');

  // Try native funding rates first
  const nativePath = path.join(dataDir, `${symbol}_funding_rates.json`);
  if (fs.existsSync(nativePath)) {
    const raw: Array<{ symbol: string; fundingRate: number; fundingRateTimestamp: number }> =
      JSON.parse(fs.readFileSync(nativePath, 'utf-8'));
    console.log(`  Loaded ${raw.length} native funding records from ${nativePath}`);
    return raw.map((r) => ({
      timestamp: r.fundingRateTimestamp,
      fundingRate: r.fundingRate,
    }));
  }

  // Fall back to futures_1h.json (forward-filled)
  const futuresPath = path.join(dataDir, `${symbol}_futures_1h.json`);
  if (fs.existsSync(futuresPath)) {
    const raw: FuturesRecord[] = JSON.parse(fs.readFileSync(futuresPath, 'utf-8'));

    // Extract unique 8h funding records (dedup by funding rate change)
    const records: FundingRecord[] = [];
    let lastRate: number | null = null;
    for (const r of raw) {
      if (r.fundingRate !== lastRate) {
        records.push({ timestamp: r.timestamp, fundingRate: r.fundingRate });
        lastRate = r.fundingRate;
      }
    }
    console.log(
      `  Loaded ${records.length} funding transitions from ${futuresPath} (${raw.length} hourly records)`,
    );
    return records;
  }

  console.log(`  No funding data found for ${symbol}`);
  return [];
}

// ============================================
// Backtest Engine
// ============================================

function backtestSymbol(
  symbol: string,
  records: FundingRecord[],
  config: BacktestConfig,
): ArbTrade[] {
  const trades: ArbTrade[] = [];
  const spread = config.spreadAssumption[symbol] ?? 0.0003;

  let inPosition = false;
  let direction: 'short_perp' | 'long_perp' = 'short_perp';
  let entryTimestamp = 0;
  let entryFundingRate = 0;
  let fundingCollected = 0;
  let fundingPayments = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const absRate = Math.abs(record.fundingRate);

    if (inPosition) {
      // Simulate funding settlement (each record = one settlement)
      const weReceive =
        (direction === 'short_perp' && record.fundingRate > 0) ||
        (direction === 'long_perp' && record.fundingRate < 0);

      const payment = config.positionSizeUSDT * Math.abs(record.fundingRate);
      fundingCollected += weReceive ? payment : -payment;
      fundingPayments++;

      const holdTimeHours =
        (record.timestamp - entryTimestamp) / (1000 * 60 * 60);

      // Check exit conditions
      let exitReason = '';

      // Rate flipped
      const expectedSign = direction === 'short_perp' ? 1 : -1;
      const currentSign = record.fundingRate > 0 ? 1 : -1;
      if (
        currentSign !== expectedSign &&
        absRate > config.closeBelowRate
      ) {
        exitReason = 'rate_flipped';
      }

      // Rate dropped
      if (!exitReason && absRate < config.closeBelowRate) {
        exitReason = 'rate_dropped';
      }

      // Max hold time
      if (!exitReason && holdTimeHours >= config.maxHoldTimeHours) {
        exitReason = 'max_hold_time';
      }

      if (exitReason) {
        // Close position
        const spreadCost =
          spread * config.positionSizeUSDT * 2 + // entry + exit spread
          config.commissionPerSide * config.positionSizeUSDT * 2; // entry + exit commission

        const netPnl = fundingCollected - spreadCost;
        const holdYears = holdTimeHours / (365.25 * 24);
        const apy =
          holdYears > 0
            ? netPnl / config.positionSizeUSDT / holdYears
            : 0;

        trades.push({
          symbol,
          direction,
          entryTimestamp,
          exitTimestamp: record.timestamp,
          entryFundingRate,
          holdTimeHours,
          fundingPayments,
          totalFundingCollected: fundingCollected,
          spreadCost,
          netPnl,
          annualizedAPY: apy,
          exitReason,
        });

        inPosition = false;
        fundingCollected = 0;
        fundingPayments = 0;
      }
    } else {
      // Check entry conditions
      if (absRate >= config.minFundingRate) {
        // Calculate break-even
        const totalEntryCost =
          spread + config.commissionPerSide * 2;
        const ratePerHour = absRate / 8;
        const breakEvenHours =
          ratePerHour > 0 ? totalEntryCost / ratePerHour : Infinity;

        if (breakEvenHours <= 16) {
          inPosition = true;
          direction =
            record.fundingRate > 0 ? 'short_perp' : 'long_perp';
          entryTimestamp = record.timestamp;
          entryFundingRate = record.fundingRate;
          fundingCollected = 0;
          fundingPayments = 0;
        }
      }
    }
  }

  // Close any remaining open position at end
  if (inPosition && records.length > 0) {
    const lastRecord = records[records.length - 1]!;
    const holdTimeHours =
      (lastRecord.timestamp - entryTimestamp) / (1000 * 60 * 60);
    const spreadCost =
      (config.spreadAssumption[symbol] ?? 0.0003) *
        config.positionSizeUSDT *
        2 +
      config.commissionPerSide * config.positionSizeUSDT * 2;
    const netPnl = fundingCollected - spreadCost;
    const holdYears = holdTimeHours / (365.25 * 24);

    trades.push({
      symbol,
      direction,
      entryTimestamp,
      exitTimestamp: lastRecord.timestamp,
      entryFundingRate,
      holdTimeHours,
      fundingPayments,
      totalFundingCollected: fundingCollected,
      spreadCost,
      netPnl,
      annualizedAPY:
        holdYears > 0
          ? netPnl / config.positionSizeUSDT / holdYears
          : 0,
      exitReason: 'end_of_data',
    });
  }

  return trades;
}

// ============================================
// Main
// ============================================

function main(): void {
  const config = parseArgs();

  console.log('='.repeat(60));
  console.log('Funding Rate Arbitrage Backtest');
  console.log('='.repeat(60));
  console.log(`Symbols: ${config.symbols.join(', ')}`);
  console.log(`Min rate: ${(config.minFundingRate * 100).toFixed(4)}%`);
  console.log(`Close below: ${(config.closeBelowRate * 100).toFixed(4)}%`);
  console.log(`Position size: $${config.positionSizeUSDT}`);
  console.log(`Commission/side: ${(config.commissionPerSide * 100).toFixed(3)}%`);
  console.log(`Max hold: ${config.maxHoldTimeHours}h`);
  console.log('');

  const allTrades: ArbTrade[] = [];

  for (const symbol of config.symbols) {
    console.log(`\n--- ${symbol} ---`);
    const records = loadFundingData(symbol);

    if (records.length === 0) continue;

    const trades = backtestSymbol(symbol, records, config);
    allTrades.push(...trades);

    // Symbol stats
    const profitable = trades.filter((t) => t.netPnl > 0);
    const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
    const totalFunding = trades.reduce(
      (s, t) => s + t.totalFundingCollected,
      0,
    );
    const totalSpread = trades.reduce((s, t) => s + t.spreadCost, 0);
    const avgHold =
      trades.length > 0
        ? trades.reduce((s, t) => s + t.holdTimeHours, 0) / trades.length
        : 0;
    const avgAPY =
      trades.length > 0
        ? trades.reduce((s, t) => s + t.annualizedAPY, 0) / trades.length
        : 0;

    console.log(`  Trades: ${trades.length} (${profitable.length} profitable, ${((profitable.length / Math.max(trades.length, 1)) * 100).toFixed(1)}% WR)`);
    console.log(`  Total funding collected: $${totalFunding.toFixed(2)}`);
    console.log(`  Total spread + commission: $${totalSpread.toFixed(2)}`);
    console.log(`  Net PnL: $${totalPnl.toFixed(2)}`);
    console.log(`  Avg hold: ${avgHold.toFixed(1)}h`);
    console.log(`  Avg annualized APY: ${(avgAPY * 100).toFixed(1)}%`);

    // Exit reason breakdown
    const reasons = new Map<string, number>();
    for (const t of trades) {
      reasons.set(t.exitReason, (reasons.get(t.exitReason) ?? 0) + 1);
    }
    console.log(`  Exit reasons: ${Array.from(reasons.entries()).map(([r, c]) => `${r}=${c}`).join(', ')}`);
  }

  // Overall stats
  console.log('\n' + '='.repeat(60));
  console.log('OVERALL RESULTS');
  console.log('='.repeat(60));

  const totalTrades = allTrades.length;
  const totalProfitable = allTrades.filter((t) => t.netPnl > 0).length;
  const totalPnl = allTrades.reduce((s, t) => s + t.netPnl, 0);
  const totalFunding = allTrades.reduce(
    (s, t) => s + t.totalFundingCollected,
    0,
  );
  const totalSpread = allTrades.reduce((s, t) => s + t.spreadCost, 0);

  console.log(`Total trades: ${totalTrades}`);
  console.log(`Profitable: ${totalProfitable} (${((totalProfitable / Math.max(totalTrades, 1)) * 100).toFixed(1)}%)`);
  console.log(`Total funding collected: $${totalFunding.toFixed(2)}`);
  console.log(`Total spread + commission: $${totalSpread.toFixed(2)}`);
  console.log(`Net PnL: $${totalPnl.toFixed(2)}`);

  if (totalTrades > 0) {
    const avgPnl = totalPnl / totalTrades;
    const avgAPY =
      allTrades.reduce((s, t) => s + t.annualizedAPY, 0) / totalTrades;
    const avgHold =
      allTrades.reduce((s, t) => s + t.holdTimeHours, 0) / totalTrades;

    console.log(`Avg PnL per trade: $${avgPnl.toFixed(2)}`);
    console.log(`Avg hold time: ${avgHold.toFixed(1)}h`);
    console.log(`Avg annualized APY: ${(avgAPY * 100).toFixed(1)}%`);

    // Per-position-size annualized return
    const dataSpanHours =
      allTrades.length > 0
        ? (allTrades[allTrades.length - 1]!.exitTimestamp -
            allTrades[0]!.entryTimestamp) /
          (1000 * 60 * 60)
        : 0;
    const dataSpanYears = dataSpanHours / (365.25 * 24);

    if (dataSpanYears > 0) {
      console.log(
        `\nCapital efficiency: $${totalPnl.toFixed(2)} on $${config.positionSizeUSDT} over ${(dataSpanYears * 12).toFixed(1)} months`,
      );
      console.log(
        `Simple return: ${((totalPnl / config.positionSizeUSDT) * 100).toFixed(1)}% over ${(dataSpanYears * 12).toFixed(1)}mo`,
      );
    }
  }

  // Save results
  const outPath = path.resolve(
    __dirname,
    '../experiments/funding-arb-backtest-results.json',
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { config, trades: allTrades, totalPnl, totalTrades },
      null,
      2,
    ),
  );
  console.log(`\nResults saved to ${outPath}`);
}

main();
