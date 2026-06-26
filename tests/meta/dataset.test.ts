import { describe, it, expect } from 'vitest';
import { buildTradeFeatureRow } from '@/lib/meta/dataset';

const SAMPLE_FACTOR_BREAKDOWN = {
  obProximity: 2.7,
  recentBOS: 2.2,
};

describe('buildTradeFeatureRow', () => {
  it('winning long trade: correct features and label=1', () => {
    const row = buildTradeFeatureRow({
      symbol: 'BTCUSDT',
      entryTimestamp: 1_700_000_000_000,
      exitTimestamp: 1_700_010_000_000,
      direction: 'long',
      factorBreakdown: SAMPLE_FACTOR_BREAKDOWN,
      confluenceScore: 4.5,
      regimeLabel: 'uptrend+normal',
      netReturn: 0.03,
    });

    // label
    expect(row.label).toBe(1);

    // factor keys preserved
    expect(row.features['obProximity']).toBe(2.7);
    expect(row.features['recentBOS']).toBe(2.2);

    // confluenceScore injected
    expect(row.features['confluenceScore']).toBe(4.5);

    // dirLong encoding: 1 for long
    expect(row.features['dirLong']).toBe(1);

    // regime one-hot
    expect(row.features['regime_uptrend+normal']).toBe(1);

    // no other regime keys present
    const regimeKeys = Object.keys(row.features).filter((k) => k.startsWith('regime_'));
    expect(regimeKeys).toHaveLength(1);

    // scalar fields correct
    expect(row.symbol).toBe('BTCUSDT');
    expect(row.entryTimestamp).toBe(1_700_000_000_000);
    expect(row.exitTimestamp).toBe(1_700_010_000_000);
    expect(row.direction).toBe('long');
  });

  it('losing trade: label=0', () => {
    const row = buildTradeFeatureRow({
      symbol: 'ETHUSDT',
      entryTimestamp: 1_700_000_000_000,
      exitTimestamp: 1_700_010_000_000,
      direction: 'long',
      factorBreakdown: SAMPLE_FACTOR_BREAKDOWN,
      confluenceScore: 4.5,
      regimeLabel: 'uptrend+normal',
      netReturn: -0.02,
    });

    expect(row.label).toBe(0);
  });

  it('short trade: dirLong=0', () => {
    const row = buildTradeFeatureRow({
      symbol: 'SOLUSDT',
      entryTimestamp: 1_700_000_000_000,
      exitTimestamp: 1_700_010_000_000,
      direction: 'short',
      factorBreakdown: SAMPLE_FACTOR_BREAKDOWN,
      confluenceScore: 3.1,
      regimeLabel: 'downtrend+high',
      netReturn: 0.01,
    });

    expect(row.features['dirLong']).toBe(0);
    expect(row.features['regime_downtrend+high']).toBe(1);
    expect(row.label).toBe(1);
  });

  it('zero return: label=0 (not strictly positive)', () => {
    const row = buildTradeFeatureRow({
      symbol: 'BTCUSDT',
      entryTimestamp: 1_700_000_000_000,
      exitTimestamp: 1_700_010_000_000,
      direction: 'long',
      factorBreakdown: {},
      confluenceScore: 5.0,
      regimeLabel: 'ranging+normal',
      netReturn: 0,
    });

    expect(row.label).toBe(0);
    expect(row.features['confluenceScore']).toBe(5.0);
    expect(row.features['dirLong']).toBe(1);
    expect(row.features['regime_ranging+normal']).toBe(1);
  });
});
