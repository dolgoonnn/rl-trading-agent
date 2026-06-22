/**
 * ICT 2022-model decision checklist.
 *
 * Each row maps a factor in the ConfluenceScorer breakdown to a human-readable
 * step from the ICT execution checklist. ✓ if factor > 0, otherwise ✗ — with
 * contribution surfaced so the trader sees *which* factors carried the score.
 */

interface Props {
  side: 'long' | 'short';
  totalScore: number;
  threshold: number;
  factorBreakdown: Record<string, number>;
}

interface Check {
  id: string;
  label: string;
  factors: string[];
  why: string;
}

const CHECKS: Check[] = [
  { id: 'bias', label: 'HTF bias aligned', factors: ['structureAlignment'], why: 'trade direction matches market bias' },
  { id: 'sweep', label: 'Liquidity sweep present', factors: ['liquiditySweep'], why: 'recent sweep of opposite-side liquidity' },
  { id: 'bos', label: 'Recent BOS / MSS', factors: ['recentBOS'], why: 'structure shift confirms direction' },
  { id: 'ob', label: 'OB / FVG entry', factors: ['obProximity', 'fvgAtCE'], why: 'price at unmitigated OB or FVG@CE' },
  { id: 'confluence', label: 'OB + FVG confluence', factors: ['obFvgConfluence'], why: 'both POIs stack at the entry' },
  { id: 'ote', label: 'OTE retracement (62-79%)', factors: ['oteZone'], why: 'institutional retracement zone' },
  { id: 'rr', label: 'R:R quality', factors: ['rrRatio'], why: 'reward justifies the risk' },
  { id: 'kz', label: 'Kill zone active', factors: ['killZoneActive'], why: 'high-probability session' },
  { id: 'momentum', label: 'Momentum confirmation', factors: ['momentumConfirmation'], why: 'recent candles agree with direction' },
];

export function ChecklistCard({ side, totalScore, threshold, factorBreakdown }: Props) {
  const passed = CHECKS.map((c) => {
    const total = c.factors.reduce((acc, f) => acc + (factorBreakdown[f] ?? 0), 0);
    return { ...c, contribution: total, ok: total > 0 };
  });
  const passedCount = passed.filter((p) => p.ok).length;
  const meetsThreshold = totalScore >= threshold;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <span className="text-xs uppercase tracking-wider text-zinc-400">Decision checklist</span>
          <span className={`ml-2 font-mono text-xs ${side === 'long' ? 'text-green-300' : 'text-red-300'}`}>
            {side.toUpperCase()}
          </span>
        </div>
        <div className="text-right">
          <div className="font-mono text-sm text-zinc-100">
            {passedCount}/{CHECKS.length} checks
          </div>
          <div className={`text-xs ${meetsThreshold ? 'text-emerald-400' : 'text-amber-400'}`}>
            score {totalScore.toFixed(2)} {meetsThreshold ? '≥' : '<'} {threshold.toFixed(2)} threshold
          </div>
        </div>
      </div>
      <ul className="space-y-1.5">
        {passed.map((c) => (
          <li
            key={c.id}
            className={`flex items-start justify-between rounded px-2 py-1 text-xs ${
              c.ok ? 'bg-emerald-950/30' : 'bg-zinc-950/40'
            }`}
          >
            <div className="flex items-start gap-2">
              <span className={c.ok ? 'text-emerald-400' : 'text-zinc-600'}>{c.ok ? '✓' : '○'}</span>
              <div>
                <div className={c.ok ? 'text-zinc-200' : 'text-zinc-500'}>{c.label}</div>
                <div className="text-[10px] text-zinc-600">{c.why}</div>
              </div>
            </div>
            <span
              className={`font-mono text-[11px] ${
                c.ok ? 'text-emerald-400' : 'text-zinc-700'
              }`}
            >
              +{c.contribution.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
