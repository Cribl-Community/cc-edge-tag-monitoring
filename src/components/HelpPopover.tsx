// A "?" affordance that keeps long explanations off the page until asked for.
//
// The Setup Guide used to print every rationale — resource ids, route filter
// expressions, credit trade-offs — inline and permanently, which is what made
// the page a wall of text. The words are unchanged; they just live one click
// away now. Popover requires a Capra button in its trigger tree, so the trigger
// is an IconButton (see @capra/core docs: core-popover--usage).

import { IconButton, Popover } from '@capra/core'
import { CircleQuestion } from '@capra/icons'
import type { ReactNode } from 'react'

export function HelpPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover content={<div className="help-popover">{children}</div>}>
      <IconButton icon={CircleQuestion} variant="tertiary" size="sm" aria-label={label} />
    </Popover>
  )
}
