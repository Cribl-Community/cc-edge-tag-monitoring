// Lightweight multi-series line chart (Capra has no chart primitive). Renders
// total volume (in+out) per tag value over time. Chrome (axes/grid/labels) is
// styled with design tokens via CSS classes; series colors come from the
// categorical palette.

import { useId, useMemo, useState } from 'react'
import { Text } from '@capra/core'
import type { ChartSeries } from '../lib/rollup'
import { formatBytes, formatTick } from '../lib/format'
import { seriesColor } from '../lib/palette'

interface Props {
  buckets: number[]
  series: ChartSeries[]
  rangeSeconds: number
}

const W = 900
const H = 300
const PAD = { top: 16, right: 16, bottom: 34, left: 64 }

export function TimeSeriesChart({ buckets, series, rangeSeconds }: Props) {
  const clipId = useId()
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  const visible = series.filter((s) => !hidden.has(s.value))

  const maxY = useMemo(() => {
    let m = 0
    for (const s of visible) for (const p of s.points) if (p > m) m = p
    return m
  }, [visible])

  if (buckets.length === 0) {
    return (
      <div className="chart-empty">
        <Text color="subtle">No time-series data points in this range.</Text>
      </div>
    )
  }

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const n = buckets.length
  const x = (i: number): number => PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const y = (v: number): number => PAD.top + plotH - (maxY <= 0 ? 0 : (v / maxY) * plotH)

  const yTicks = niceTicks(maxY, 4)
  // Show at most ~6 x labels to avoid crowding.
  const xLabelEvery = Math.max(1, Math.ceil(n / 6))

  const toggle = (value: string): void => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="Volume over time">
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* Y grid + labels */}
        {yTicks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={PAD.left} y1={y(t)} x2={W - PAD.right} y2={y(t)} />
            <text className="chart-axis-label" x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {formatBytes(t)}
            </text>
          </g>
        ))}

        {/* X labels */}
        {buckets.map((b, i) =>
          i % xLabelEvery === 0 ? (
            <text key={b} className="chart-axis-label" x={x(i)} y={H - PAD.bottom + 18} textAnchor="middle">
              {formatTick(b, rangeSeconds)}
            </text>
          ) : null,
        )}

        {/* Series lines */}
        <g clipPath={`url(#${clipId})`}>
          {series.map((s, idx) =>
            hidden.has(s.value) ? null : (
              <polyline
                key={s.value}
                fill="none"
                stroke={seriesColor(idx)}
                strokeWidth={2}
                points={s.points.map((p, i) => `${x(i)},${y(p)}`).join(' ')}
              />
            ),
          )}
        </g>
      </svg>

      <div className="chart-legend">
        {series.map((s, idx) => (
          <button
            key={s.value}
            type="button"
            className="chart-legend-item"
            aria-pressed={!hidden.has(s.value)}
            onClick={() => toggle(s.value)}
          >
            <span
              className="chart-legend-swatch"
              style={{ backgroundColor: hidden.has(s.value) ? 'transparent' : seriesColor(idx), borderColor: seriesColor(idx) }}
            />
            <Text variant="body-sm-normal" color={hidden.has(s.value) ? 'subtle' : 'default'}>
              {s.value}
            </Text>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Round, evenly-spaced tick values from 0..max. */
function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0]
  const raw = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag
  const ticks: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v)
  return ticks
}
