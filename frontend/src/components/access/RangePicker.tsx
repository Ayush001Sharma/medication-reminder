import { useState, type FormEvent } from 'react'
import { MAX_REPORT_DAYS, validateRange, type RangeErrors } from '../../lib/report'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'

/**
 * From / To dates for a report, in the patient's local calendar. Checks the range (end not before start, at most
 * 366 days) before anything is sent. The draft restarts whenever the applied range changes, so mount it with a
 * `key` built from that range.
 */
export function RangePicker({
  from,
  to,
  onApply,
  onReset,
  disabled = false,
  serverError,
}: {
  from: string
  to: string
  onApply: (from: string, to: string) => void
  onReset: () => void
  disabled?: boolean
  /** A range problem reported by the API, shown under the end date. */
  serverError?: string
}) {
  const [draftFrom, setDraftFrom] = useState(from)
  const [draftTo, setDraftTo] = useState(to)
  const [errors, setErrors] = useState<RangeErrors>({})

  function submit(event: FormEvent) {
    event.preventDefault()
    const found = validateRange(draftFrom, draftTo)
    setErrors(found)
    if (!found.from && !found.to) onApply(draftFrom, draftTo)
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Report dates" className="mb-6 rounded-2xl border border-line bg-surface p-4 shadow-soft">
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
        <Input label="From" type="date" value={draftFrom} disabled={disabled} error={errors.from} onChange={(e) => setDraftFrom(e.target.value)} />
        <Input
          label="To"
          type="date"
          value={draftTo}
          disabled={disabled}
          error={errors.to ?? serverError}
          hint={`Up to ${MAX_REPORT_DAYS} days. Dates are in the patient's own timezone.`}
          onChange={(e) => setDraftTo(e.target.value)}
        />
        <div className="flex flex-wrap gap-2 sm:mt-7">
          <Button type="submit" disabled={disabled}>
            Show report
          </Button>
          <Button variant="ghost" disabled={disabled} onClick={onReset}>
            Last 30 days
          </Button>
        </div>
      </div>
    </form>
  )
}
