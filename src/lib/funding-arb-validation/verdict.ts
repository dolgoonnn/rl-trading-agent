import type { ValidationCheck } from './types';

export interface Verdict {
  passCount: number;
  totalCount: number;
  recommendation: string;
}

export function assembleVerdict(checks: ValidationCheck[]): Verdict {
  const passCount = checks.filter((c: ValidationCheck) => c.pass).length;
  const totalCount = checks.length;

  let recommendation: string;
  if (totalCount === 5 && passCount === 5) {
    recommendation = `${passCount}/${totalCount} PASS — deploy with confidence`;
  } else if (totalCount === 5 && passCount === 4) {
    recommendation = `${passCount}/${totalCount} — deploy`;
  } else {
    recommendation = `${passCount}/${totalCount} — stop and document findings`;
  }

  return { passCount, totalCount, recommendation };
}
