// Join Search result rows (per host, per time bucket) to node tags and roll up
// to the chosen tag dimension. Untagged hosts bucket as (untagged); volume for
// hosts absent from /master/workers buckets as (unknown host) so no bytes are
// silently dropped — totals always reconcile.

import { hostPassesFilters, tagValueForHost, UNKNOWN_HOST, type TagIndex } from './tags'

export interface VolumeRow {
  value: string
  inBytes: number
  outBytes: number
  total: number
  hostCount: number
}

export interface ChartSeries {
  value: string
  /** in+out bytes per bucket, aligned to `buckets`. */
  points: number[]
}

export interface RollupResult {
  table: VolumeRow[]
  totals: { inBytes: number; outBytes: number }
  /** Sorted bucket timestamps (ms) for the chart x-axis. */
  buckets: number[]
  series: ChartSeries[]
  droppedNoHost: number
}

interface RawRow {
  host: string
  time: number
  inBytes: number
  outBytes: number
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Normalize a _time field (epoch s, epoch ms, or ISO string) to epoch ms. */
function toMs(v: unknown): number {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  const s = String(v)
  const asNum = Number(s)
  if (Number.isFinite(asNum)) return asNum > 1e12 ? asNum : asNum * 1000
  const parsed = Date.parse(s)
  return Number.isFinite(parsed) ? parsed : 0
}

export function rollup(
  rows: Record<string, unknown>[],
  index: TagIndex,
  hostField: string,
  groupBy: string,
  filters: Record<string, string>,
): RollupResult {
  // 1. Normalize + filter rows.
  const clean: RawRow[] = []
  let droppedNoHost = 0
  for (const r of rows) {
    const host = r[hostField]
    if (host == null || host === '') {
      droppedNoHost++
      continue
    }
    const hostStr = String(host)
    if (!hostPassesFilters(index, hostStr, filters)) continue
    clean.push({
      host: hostStr,
      time: toMs(r._time ?? r.time),
      inBytes: num(r.in_bytes),
      outBytes: num(r.out_bytes),
    })
  }

  // 2. Aggregate totals per group value and per (group, bucket).
  const totalsByValue = new Map<string, { inBytes: number; outBytes: number; hosts: Set<string> }>()
  const bucketSet = new Set<number>()
  const seriesMap = new Map<string, Map<number, number>>()

  for (const row of clean) {
    const value = tagValueForHost(index, row.host, groupBy) ?? UNKNOWN_HOST
    if (!totalsByValue.has(value)) {
      totalsByValue.set(value, { inBytes: 0, outBytes: 0, hosts: new Set() })
    }
    const agg = totalsByValue.get(value)!
    agg.inBytes += row.inBytes
    agg.outBytes += row.outBytes
    agg.hosts.add(row.host)

    if (row.time > 0) {
      bucketSet.add(row.time)
      if (!seriesMap.has(value)) seriesMap.set(value, new Map())
      const byBucket = seriesMap.get(value)!
      byBucket.set(row.time, (byBucket.get(row.time) ?? 0) + row.inBytes + row.outBytes)
    }
  }

  // 3. Build sorted table.
  const table: VolumeRow[] = [...totalsByValue.entries()]
    .map(([value, agg]) => ({
      value,
      inBytes: agg.inBytes,
      outBytes: agg.outBytes,
      total: agg.inBytes + agg.outBytes,
      hostCount: agg.hosts.size,
    }))
    .sort((a, b) => b.total - a.total)

  const totals = table.reduce(
    (acc, r) => ({ inBytes: acc.inBytes + r.inBytes, outBytes: acc.outBytes + r.outBytes }),
    { inBytes: 0, outBytes: 0 },
  )

  // 4. Build aligned chart series (in table order for stable colors).
  const buckets = [...bucketSet].sort((a, b) => a - b)
  const series: ChartSeries[] = table.map((row) => {
    const byBucket = seriesMap.get(row.value)
    return {
      value: row.value,
      points: buckets.map((t) => byBucket?.get(t) ?? 0),
    }
  })

  return { table, totals, buckets, series, droppedNoHost }
}
