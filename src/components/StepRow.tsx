// One actionable step in the Setup Guide.
//
// Deliberately shallow: a number, a title, the detected status, ONE line of
// summary, and the action. Everything else goes in `help` (behind a "?") so a
// configured guide reads as a short status list instead of an essay. `caution`
// is the exception — a single visible line for things that can quietly break a
// customer's existing pipeline (route order, the `final` flag), with the full
// explanation in `help`.
//
// Rows render as one bordered list with dividers between them rather than eight
// separate cards, which was a large part of the old visual noise.

import { Pill, Text } from '@capra/core'
import type { ReactNode } from 'react'
import { HelpPopover } from './HelpPopover'

export type StepStatus = 'ready' | 'missing' | 'unknown'

export function StepRow({
  n,
  title,
  status,
  summary,
  caution,
  help,
  action,
}: {
  n: number
  title: string
  status: StepStatus
  /** One short line. Keep it to what the reader needs to decide to click. */
  summary?: ReactNode
  /** A single visible warning line. Use only for "this can break something". */
  caution?: ReactNode
  /** Full explanation, shown in a popover behind a "?". */
  help?: ReactNode
  action: ReactNode
}) {
  return (
    <div className={status === 'ready' ? 'step-row step-row-done' : 'step-row'}>
      <div className="step-row-num">{n}</div>
      <div className="step-row-body">
        <div className="step-row-head">
          <Text variant="body-sm-semibold">{title}</Text>
          {status === 'ready' && (
            <Pill appearance="success" variant="muted">
              Ready
            </Pill>
          )}
          {status === 'missing' && (
            <Pill appearance="warning" variant="muted">
              Missing
            </Pill>
          )}
          {help && <HelpPopover label={`About ${title}`}>{help}</HelpPopover>}
        </div>
        {summary != null &&
          (typeof summary === 'string' ? (
            <Text color="subtle" variant="body-sm-normal">
              {summary}
            </Text>
          ) : (
            summary
          ))}
        {caution != null && (
          <Text color="warning" variant="body-sm-normal">
            {caution}
          </Text>
        )}
      </div>
      <div className="step-row-action">{action}</div>
    </div>
  )
}
