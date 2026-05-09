import { describe, it, expect } from 'vitest';
import { assembleVerdict } from '@/lib/funding-arb-validation/verdict';
import type { ValidationCheck } from '@/lib/funding-arb-validation/types';

const c = (name: string, pass: boolean): ValidationCheck => ({
  name,
  value: pass ? 'good' : 'bad',
  threshold: 'X',
  pass,
});

describe('assembleVerdict', () => {
  it('returns DEPLOY_WITH_CONFIDENCE on 5/5', () => {
    const v = assembleVerdict([c('a', true), c('b', true), c('c', true), c('d', true), c('e', true)]);
    expect(v.passCount).toBe(5);
    expect(v.totalCount).toBe(5);
    expect(v.recommendation).toMatch(/deploy with confidence/i);
  });

  it('returns DEPLOY on 4/5', () => {
    const v = assembleVerdict([c('a', true), c('b', true), c('c', true), c('d', true), c('e', false)]);
    expect(v.passCount).toBe(4);
    expect(v.recommendation).toMatch(/^[0-9]+\/[0-9]+\s*[—-]\s*deploy/i);
    expect(v.recommendation).not.toMatch(/confidence/i);
  });

  it('returns STOP on <=3/5', () => {
    const v = assembleVerdict([c('a', true), c('b', true), c('c', true), c('d', false), c('e', false)]);
    expect(v.passCount).toBe(3);
    expect(v.recommendation).toMatch(/stop/i);
  });

  it('handles all-failing', () => {
    const v = assembleVerdict([c('a', false), c('b', false)]);
    expect(v.passCount).toBe(0);
    expect(v.recommendation).toMatch(/stop/i);
  });
});
