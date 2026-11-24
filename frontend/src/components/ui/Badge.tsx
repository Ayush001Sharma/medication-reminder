import type { ReactNode } from 'react'
import type { DoseStatus } from '../../api/types'
import { cx } from '../../lib/cx'

export type BadgeTone = 'success' | 'neutral' | 'info' | 'attention' | 'danger'

/*
 * Every chip pairs a fill with text that passes AA: sage-dark on sage-tint 5.0, ink on subtle 11.9,
 * sage-dark on white 6.0, ink on clay 4.8, white on danger 5.3. Meaning is carried by the WORD, never by
 * colour alone.
 */
const tones: Record<BadgeTone, string> = {
  success: 'bg-sage-tint text-sage-dark',
  neutral: 'bg-subtle text-ink',
  info: 'bg-surface text-sage-dark ring-1 ring-inset ring-sage-dark',
  attention: 'bg-clay text-ink',
  danger: 'bg-danger text-surface',
}

export function Badge({ tone = 'neutral', children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold leading-5',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

const DOSE_STATUS: Record<DoseStatus, { tone: BadgeTone; label: string }> = {
  pending: { tone: 'neutral', label: 'Upcoming' },
  reminded: { tone: 'info', label: 'Reminder sent' },
  taken: { tone: 'success', label: 'Taken' },
  missed: { tone: 'attention', label: 'Missed' },
  skipped: { tone: 'neutral', label: 'Skipped' },
}

/** A dose's status as a chip. A dose taken after it was already missed reads "Taken late". */
export function DoseStatusBadge({ status, late = false }: { status: DoseStatus; late?: boolean }) {
  const { tone, label } = DOSE_STATUS[status]
  return <Badge tone={tone}>{status === 'taken' && late ? 'Taken late' : label}</Badge>
}
