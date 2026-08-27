// Categorical color palette for chart/table series. Design tokens are semantic
// (success/danger/etc.) and don't cover arbitrary categorical series, so an
// explicit, colorblind-friendly palette is used for series identity only.
const PALETTE = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#ef4444', // red
  '#6366f1', // indigo
  '#84cc16', // lime
  '#f97316', // orange
]

export function seriesColor(i: number): string {
  return PALETTE[i % PALETTE.length]
}
