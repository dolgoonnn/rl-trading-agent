export function formatUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function formatPnlPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}
export function sleeveStatusLabel(s: { closedTrades: number; openPositions: number }): string {
  if (s.openPositions > 0) return 'in position';
  if (s.closedTrades > 0) return 'active';
  return 'flat';
}
