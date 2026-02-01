#!/usr/bin/env npx tsx
/**
 * Analyze train/val data characteristics
 */
import fs from 'fs';

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const data = JSON.parse(fs.readFileSync('./data/BTCUSDT_1h.json', 'utf-8')) as Candle[];

const trainSplit = 0.8;
const splitIdx = Math.floor(data.length * trainSplit);
const trainData = data.slice(0, splitIdx);
const valData = data.slice(splitIdx);

console.log('=== Data Analysis ===\n');
console.log(`Total candles: ${data.length}`);
console.log(`Train candles: ${trainData.length} (${(trainData.length/data.length*100).toFixed(1)}%)`);
console.log(`Val candles: ${valData.length} (${(valData.length/data.length*100).toFixed(1)}%)`);

const trainStart = new Date(trainData[0]!.timestamp);
const trainEnd = new Date(trainData[trainData.length-1]!.timestamp);
const valStart = new Date(valData[0]!.timestamp);
const valEnd = new Date(valData[valData.length-1]!.timestamp);

console.log(`\nTrain period: ${trainStart.toISOString().split('T')[0]} to ${trainEnd.toISOString().split('T')[0]}`);
console.log(`Val period: ${valStart.toISOString().split('T')[0]} to ${valEnd.toISOString().split('T')[0]}`);

// Calculate price changes
const calcReturns = (candles: Candle[]) => {
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    returns.push((candles[i]!.close - candles[i-1]!.close) / candles[i-1]!.close);
  }
  return returns;
};

const trainReturns = calcReturns(trainData);
const valReturns = calcReturns(valData);

const mean = (arr: number[]) => arr.reduce((a,b) => a+b, 0) / arr.length;
const std = (arr: number[]) => {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a,b) => a + Math.pow(b-m, 2), 0) / arr.length);
};

console.log('\n=== Market Characteristics ===\n');
console.log('Training Period:');
console.log(`  Mean hourly return: ${(mean(trainReturns)*100).toFixed(4)}%`);
console.log(`  Volatility (std): ${(std(trainReturns)*100).toFixed(4)}%`);
console.log(`  Total return: ${((trainData[trainData.length-1]!.close / trainData[0]!.close - 1)*100).toFixed(2)}%`);
console.log(`  Price range: ${trainData[0]!.close.toFixed(0)} to ${trainData[trainData.length-1]!.close.toFixed(0)}`);

console.log('\nValidation Period:');
console.log(`  Mean hourly return: ${(mean(valReturns)*100).toFixed(4)}%`);
console.log(`  Volatility (std): ${(std(valReturns)*100).toFixed(4)}%`);
console.log(`  Total return: ${((valData[valData.length-1]!.close / valData[0]!.close - 1)*100).toFixed(2)}%`);
console.log(`  Price range: ${valData[0]!.close.toFixed(0)} to ${valData[valData.length-1]!.close.toFixed(0)}`);

// Check for regime change
const trainPositive = trainReturns.filter(r => r > 0).length / trainReturns.length;
const valPositive = valReturns.filter(r => r > 0).length / valReturns.length;

console.log('\n=== Regime Analysis ===\n');
console.log(`Train: ${(trainPositive*100).toFixed(1)}% positive candles`);
console.log(`Val: ${(valPositive*100).toFixed(1)}% positive candles`);

if (Math.abs(mean(trainReturns) - mean(valReturns)) > std(trainReturns) * 0.5) {
  console.log('\nWARNING: Significant regime difference between train and val periods!');
}
