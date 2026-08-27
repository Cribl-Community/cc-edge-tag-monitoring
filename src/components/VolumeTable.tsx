// Summary table of volume per tag value. Capra has no data-grid, so this is a
// plain semantic <table> styled with design tokens (see App.css).

import { Text } from '@capra/core'
import type { VolumeRow } from '../lib/rollup'
import { formatBytes, formatPercent } from '../lib/format'
import { seriesColor } from '../lib/palette'

interface Props {
  rows: VolumeRow[]
  totals: { inBytes: number; outBytes: number }
  groupBy: string
}

export function VolumeTable({ rows, totals, groupBy }: Props) {
  const grand = totals.inBytes + totals.outBytes
  return (
    <div className="vtable-wrap">
      <table className="vtable">
        <thead>
          <tr>
            <th className="vtable-th">{groupBy || 'Group'}</th>
            <th className="vtable-th vtable-num">Ingest</th>
            <th className="vtable-th vtable-num">Sent</th>
            <th className="vtable-th vtable-num">Total</th>
            <th className="vtable-th vtable-num">% of total</th>
            <th className="vtable-th vtable-num">Nodes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.value}>
              <td className="vtable-td">
                <span className="vtable-swatch" style={{ backgroundColor: seriesColor(i) }} />
                <Text variant="body-sm-semibold">{r.value}</Text>
              </td>
              <td className="vtable-td vtable-num">{formatBytes(r.inBytes)}</td>
              <td className="vtable-td vtable-num">{formatBytes(r.outBytes)}</td>
              <td className="vtable-td vtable-num">{formatBytes(r.total)}</td>
              <td className="vtable-td vtable-num">{formatPercent(r.total, grand)}</td>
              <td className="vtable-td vtable-num">{r.hostCount}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="vtable-td vtable-foot">Total</td>
            <td className="vtable-td vtable-num vtable-foot">{formatBytes(totals.inBytes)}</td>
            <td className="vtable-td vtable-num vtable-foot">{formatBytes(totals.outBytes)}</td>
            <td className="vtable-td vtable-num vtable-foot">{formatBytes(grand)}</td>
            <td className="vtable-td vtable-num vtable-foot">100%</td>
            <td className="vtable-td vtable-num vtable-foot" />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
