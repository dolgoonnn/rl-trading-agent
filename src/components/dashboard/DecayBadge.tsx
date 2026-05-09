interface Props {
  tripped: boolean;
  reason?: string;
}

export function DecayBadge({ tripped, reason }: Props) {
  if (tripped) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-yellow-700/60 bg-yellow-900/30 px-2 py-1 text-xs font-mono text-yellow-200"
        title={reason ?? 'Strategy decay tripped'}
      >
        ⚠ DECAY
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-700/40 bg-emerald-900/30 px-2 py-1 text-xs font-mono text-emerald-200">
      ✓ HEALTHY
    </span>
  );
}
