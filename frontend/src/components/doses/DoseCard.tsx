import type { Dose } from '../../api/types'
import { timeInZone } from '../../lib/dates'
import { canSkip, canTake, localTimeOf, type DoseAction } from '../../lib/doses'
import { DoseStatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Hint } from '../ui/Hint'

interface DoseCardProps {
  dose: Dose
  timeZone: string
  /** Without this the card is read-only (the Upcoming page). */
  onAction?: (dose: Dose, action: DoseAction) => void
  /** A request for this dose is in flight: the buttons wait. */
  busy?: boolean
}

/**
 * One dose: local time, medication, dosage, status chip, and (when allowed) Taken / Skip. The buttons follow what
 * the API permits: a missed dose can only be taken (late), and taken or skipped doses are final.
 */
export function DoseCard({ dose, timeZone, onAction, busy = false }: DoseCardProps) {
  const time = localTimeOf(dose)
  const name = dose.medication.name
  const showActions = onAction && (canTake(dose) || canSkip(dose))
  return (
    <Card className="!p-4 sm:!p-5" aria-busy={busy || undefined}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="w-[4.5rem] shrink-0 font-display text-2xl font-semibold text-ink">{time}</span>
        <div className="min-w-0 flex-1 basis-40">
          <p className="break-words text-base font-semibold text-ink">{name}</p>
          <Hint>
            {dose.medication.dosage}
            {dose.medication.instructions ? ` · ${dose.medication.instructions}` : ''}
          </Hint>
          {dose.status === 'taken' && dose.taken_at && <Hint>Taken at {timeInZone(dose.taken_at, timeZone)}</Hint>}
          {dose.status === 'missed' && <Hint>You can still record it as taken.</Hint>}
        </div>
        <DoseStatusBadge status={dose.status} late={dose.taken_late} />
      </div>
      {showActions && (
        <div className="mt-4 flex gap-3">
          {canTake(dose) && (
            <Button className="flex-1 sm:flex-none" disabled={busy} aria-label={`Taken: ${name} at ${time}`} onClick={() => onAction(dose, 'taken')}>
              Taken
            </Button>
          )}
          {canSkip(dose) && (
            <Button
              className="flex-1 sm:flex-none"
              variant="secondary"
              disabled={busy}
              aria-label={`Skip: ${name} at ${time}`}
              onClick={() => onAction(dose, 'skip')}
            >
              Skip
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}
