// Formatting helpers for volume numbers. Accuracy matters, so byte math uses
// binary units (1024) and we keep full precision internally — formatting is
// display-only.

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']

/** Human-readable bytes, e.g. 1536 -> "1.5 KiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const value = bytes / Math.pow(1024, exp)
  const digits = value >= 100 || exp === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${BYTE_UNITS[exp]}`
}

/** Thousands-separated integer count. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toLocaleString('en-US')
}

/** Percent of a total, e.g. 0.25 -> "25.0%". Guards divide-by-zero. */
export function formatPercent(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '—'
  return `${((part / total) * 100).toFixed(1)}%`
}

/** Short local time label for a chart axis tick. */
export function formatTick(epochMs: number, rangeSeconds: number): string {
  const d = new Date(epochMs)
  // For ranges over ~2 days, show date; otherwise show time.
  if (rangeSeconds > 2 * 24 * 3600) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}
