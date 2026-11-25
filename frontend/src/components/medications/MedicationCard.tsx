import type { MedicationWithSchedules } from '../../api/types'
import { shortDate } from '../../lib/dates'
import { scheduleSummary } from '../../lib/medications'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { ButtonLink } from '../ui/ButtonLink'
import { Card } from '../ui/Card'
import { Hint } from '../ui/Hint'

interface MedicationCardProps {
  medication: MedicationWithSchedules
  /** Open the "stop this medication?" confirmation. */
  onStop?: (medication: MedicationWithSchedules) => void
}

/** A medication with its schedules. Stopped ones are read-only. */
export function MedicationCard({ medication, onStop }: MedicationCardProps) {
  const active = medication.is_active
  return (
    <Card as="article" aria-labelledby={`med-${medication.id}-name`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`med-${medication.id}-name`} className="break-words font-display text-xl font-semibold text-ink">
            {medication.name}
          </h2>
          <p className="text-base text-ink">{medication.dosage}</p>
        </div>
        {!active && <Badge tone="neutral">Stopped</Badge>}
      </div>

      {medication.instructions && <Hint className="mt-2">{medication.instructions}</Hint>}

      <Hint className="mt-2">
        From {shortDate(medication.start_date)} · {medication.end_date ? `until ${shortDate(medication.end_date)}` : 'no end date'}
      </Hint>

      <div className="mt-4 space-y-3">
        {medication.schedules.length === 0 && <Hint>No schedule yet, so no reminders.</Hint>}
        {medication.schedules.map((schedule) => {
          const { times, days } = scheduleSummary(schedule)
          return (
            <div key={schedule.id} className="rounded-2xl bg-subtle p-3">
              <ul aria-label="Times" className="flex flex-wrap gap-2">
                {times.map((time) => (
                  <li key={time} className="rounded-full bg-surface px-3 py-1 text-sm font-semibold text-ink">
                    {time}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-ink">{days}</p>
            </div>
          )
        })}
      </div>

      {active && (
        <div className="mt-5 flex flex-wrap gap-3">
          <ButtonLink to={`/medications/${medication.id}/edit`} variant="secondary" size="md" aria-label={`Edit ${medication.name}`}>
            Edit
          </ButtonLink>
          {onStop && (
            <Button variant="ghost" size="md" aria-label={`Stop ${medication.name}`} onClick={() => onStop(medication)}>
              Stop
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}
