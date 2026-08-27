// Time-range presets and Cribl Search query construction. The query aggregates
// per-host in/out bytes into time buckets; the app then joins host->tag and
// rolls up to the chosen tag dimension (see Dashboard).

import type { FieldMapping } from './config'

export interface TimeRange {
  id: string
  label: string
  /** Lookback window in seconds. */
  seconds: number
  /** bin() bucket expression for the chart, e.g. "30m". */
  bucket: string
  /** Approximate bucket width in ms (for chart x-axis math). */
  bucketMs: number
}

export const TIME_RANGES: TimeRange[] = [
  { id: '1h', label: 'Last 1 hour', seconds: 3600, bucket: '1m', bucketMs: 60_000 },
  { id: '6h', label: 'Last 6 hours', seconds: 6 * 3600, bucket: '5m', bucketMs: 5 * 60_000 },
  { id: '24h', label: 'Last 24 hours', seconds: 24 * 3600, bucket: '30m', bucketMs: 30 * 60_000 },
  { id: '7d', label: 'Last 7 days', seconds: 7 * 24 * 3600, bucket: '3h', bucketMs: 3 * 3600_000 },
  { id: '30d', label: 'Last 30 days', seconds: 30 * 24 * 3600, bucket: '1d', bucketMs: 24 * 3600_000 },
]

export function rangeById(id: string): TimeRange {
  return TIME_RANGES.find((r) => r.id === id) ?? TIME_RANGES[2]
}

/** Escape a value for safe inclusion inside a double-quoted Search string. */
function q(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build the aggregation query: sum in/out bytes per host per time bucket.
 * Returns rows with { <hostField>, _time, in_bytes, out_bytes }.
 */
export function buildVolumeQuery(dataset: string, m: FieldMapping, range: TimeRange): string {
  const mn = m.metricNameField
  const val = m.valueField
  const host = m.hostField
  // Cribl Search is KQL: logical OR is the `or` keyword, not `||` (a bare `|`
  // starts a new command), so filter with `in (...)`. The conditional scalar
  // function is `iff(predicate, then, else)` — `if` is not a Kusto function.
  return [
    `dataset="${q(dataset)}"`,
    `| where ${mn} in ("${q(m.inBytesMetric)}", "${q(m.outBytesMetric)}")`,
    `| summarize in_bytes=sum(iff(${mn}=="${q(m.inBytesMetric)}", ${val}, 0)),` +
      ` out_bytes=sum(iff(${mn}=="${q(m.outBytesMetric)}", ${val}, 0))` +
      ` by ${host}, _time=bin(_time, ${range.bucket})`,
  ].join('\n')
}

/** A small sample of raw dataset rows, for the Setup Guide verify step. */
export function buildSampleQuery(dataset: string): string {
  return `dataset="${q(dataset)}" | limit 20`
}

/** Relative earliest/latest strings accepted by the Search jobs API. */
export function rangeBounds(range: TimeRange): { earliest: string; latest: string } {
  return { earliest: `-${range.seconds}s`, latest: 'now' }
}

/**
 * Deep link into the Cribl Search UI for a search the app has already run, so the
 * user can open that exact job and explore it interactively. The Search UI lives
 * at the same origin that serves this app; `apiUrl` is window.CRIBL_API_URL
 * (e.g. https://<host>/api/v1), from which we take the origin.
 *
 * The path segment after `/search/` is a JOB ID — the UI loads results for that
 * job, so a bare `/search?...` (no job id) renders a blank page. We therefore
 * link to `/search/<jobId>` using the id returned by runSearchJob. The UI's URL
 * params differ from the job API's: query is `q`, the time bounds are `et`/`lt`
 * (same relative `-<n>s` / `now` values the job API takes), `tab=events` selects
 * the results tab, and `sr=1` runs immediately. The query is collapsed to a
 * single line here: the `sr=1` auto-run fires reliably for a single-line `q`,
 * whereas an encoded multi-line query (`%0A`) populates the bar but doesn't
 * always execute. Returns null when the origin can't be derived (e.g. a non-URL
 * base in a local dev build) or no job id is available, so the caller can hide
 * the action rather than render a broken link.
 */
export function buildSearchUiUrl(
  apiUrl: string,
  jobId: string,
  query: string,
  earliest: string,
  latest: string,
): string | null {
  if (!jobId) return null
  let origin: string
  try {
    origin = new URL(apiUrl).origin
  } catch {
    return null
  }
  const singleLine = query.replace(/\s*\n\s*/g, ' ').trim()
  const params = new URLSearchParams({
    q: singleLine,
    et: earliest,
    lt: latest,
    tz: 'local',
    tab: 'events',
    sr: '1',
  })
  return `${origin}/search/${encodeURIComponent(jobId)}?${params.toString()}`
}
