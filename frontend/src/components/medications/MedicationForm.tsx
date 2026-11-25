import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../../api/client'
import type { Medication, Schedule } from '../../api/types'
import { cx } from '../../lib/cx'
import {
  addTime, emptyValues, mapApiErrors, toMedicationPayload, toSchedulePayload, validateMedication, valuesFromMedication, WEEKDAYS,
  type FormErrors, type FormField, type MedicationFormValues,
} from '../../lib/medications'
import { useToast } from '../../toast/context'
import { Button } from '../ui/Button'
import { ButtonLink } from '../ui/ButtonLink'
import { Card, CardTitle } from '../ui/Card'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'

interface MedicationFormProps {
  mode: 'create' | 'edit'
  /** The patient's timezone, shown next to the times (they are local clock times). */
  timeZone: string
  /** Today's date in that timezone: the default start date and the earliest end date. */
  today: string
  medication?: Medication
  /** The medication's first schedule, when editing. */
  schedule?: Schedule
  /** Schedules beyond the first: kept as they are, but not editable here. */
  otherSchedules?: number
}

/** The element to focus for each field when validation fails. */
const FIELD_ID: Record<Exclude<FormField, 'form'>, string> = {
  name: 'med-name',
  dosage: 'med-dosage',
  instructions: 'med-instructions',
  startDate: 'med-start',
  endDate: 'med-end',
  times: 'med-time-input',
  days: 'day-0',
}
const FIELD_ORDER: Array<Exclude<FormField, 'form'>> = ['name', 'dosage', 'instructions', 'startDate', 'endDate', 'times', 'days']

export function MedicationForm({ mode, timeZone, today, medication, schedule, otherSchedules = 0 }: MedicationFormProps) {
  const navigate = useNavigate()
  const toast = useToast()
  const [values, setValues] = useState<MedicationFormValues>(() => (medication ? valuesFromMedication(medication, schedule) : emptyValues(today)))
  const [errors, setErrors] = useState<FormErrors>({})
  const [newTime, setNewTime] = useState('')
  const [timeError, setTimeError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  // Creating is two requests (medication, then schedule). If the second fails the medication already exists, so
  // a retry must update it instead of creating a duplicate.
  const [createdId, setCreatedId] = useState<number | null>(null)

  function update<K extends keyof MedicationFormValues>(field: K, value: MedicationFormValues[K], errorField?: FormField) {
    setValues((previous) => ({ ...previous, [field]: value }))
    const cleared = errorField ?? (field as FormField)
    setErrors((previous) => ({ ...previous, [cleared]: undefined, form: undefined }))
  }

  function addTimeFromInput() {
    const result = addTime(values.times, newTime)
    if (result.error) {
      setTimeError(result.error)
      return
    }
    setTimeError(undefined)
    update('times', result.times, 'times')
    setNewTime('')
    document.getElementById(FIELD_ID.times)?.focus()
  }

  function toggleDay(day: number) {
    update('days', values.days.includes(day) ? values.days.filter((d) => d !== day) : [...values.days, day].sort((a, b) => a - b), 'days')
  }

  function showErrors(found: FormErrors) {
    setErrors(found)
    const first = FIELD_ORDER.find((field) => found[field])
    if (first) document.getElementById(FIELD_ID[first])?.focus()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const found = validateMedication(values, today, medication?.end_date ?? null)
    if (Object.keys(found).length > 0) {
      showErrors(found)
      return
    }
    setErrors({})
    setBusy(true)
    let medicationSaved = createdId !== null || mode === 'edit'
    try {
      const id = mode === 'edit' ? (medication as Medication).id : createdId
      let medicationId: number
      if (id === null) {
        medicationId = (await api.post<Medication>('/api/medications/', toMedicationPayload(values))).id
        setCreatedId(medicationId)
      } else {
        medicationId = id
        await api.patch(`/api/medications/${medicationId}/`, toMedicationPayload(values))
      }
      medicationSaved = true
      if (mode === 'edit' && schedule) {
        await api.patch(`/api/medications/${medicationId}/schedules/${schedule.id}/`, toSchedulePayload(values))
      } else {
        await api.post(`/api/medications/${medicationId}/schedules/`, toSchedulePayload(values))
      }
      toast.success(mode === 'create' ? `${values.name.trim()} added.` : `${values.name.trim()} updated.`)
      navigate('/medications')
    } catch (error) {
      const mapped = error instanceof ApiError ? mapApiErrors(error.fieldErrors, error.message) : { form: 'Something went wrong. Please try again.' }
      if (mode === 'create' && medicationSaved) {
        mapped.form = `${values.name.trim() || 'The medication'} was saved, but its schedule was not. ${mapped.form ?? 'Fix the highlighted fields and save again.'}`
      }
      showErrors(mapped)
      setBusy(false)
    }
  }

  const hasErrors = Object.values(errors).some(Boolean)

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      {hasErrors && (
        <div role="alert" className="rounded-2xl border border-danger bg-surface p-4 text-base text-danger">
          <p className="font-semibold">{errors.form ?? 'Please fix the highlighted fields.'}</p>
        </div>
      )}

      <Card as="section" aria-labelledby="med-details-title" className="space-y-5">
        <CardTitle id="med-details-title">Medication</CardTitle>
        <Input id="med-name" label="Name" autoComplete="off" required value={values.name} onChange={(e) => update('name', e.target.value)} error={errors.name} />
        <Input
          id="med-dosage"
          label="Dosage"
          autoComplete="off"
          required
          hint="For example 500 mg, or 2 tablets."
          value={values.dosage}
          onChange={(e) => update('dosage', e.target.value)}
          error={errors.dosage}
        />
        <Textarea
          id="med-instructions"
          label="Instructions (optional)"
          hint="For example: take with food."
          value={values.instructions}
          onChange={(e) => update('instructions', e.target.value)}
          error={errors.instructions}
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <Input id="med-start" label="Start date" type="date" required value={values.startDate} onChange={(e) => update('startDate', e.target.value)} error={errors.startDate} />
          <Input
            id="med-end"
            label="End date (optional)"
            type="date"
            min={values.startDate || undefined}
            hint="Leave empty to continue until you stop it."
            value={values.endDate}
            onChange={(e) => update('endDate', e.target.value)}
            error={errors.endDate}
          />
        </div>
      </Card>

      <Card as="section" aria-labelledby="med-schedule-title" className="space-y-6">
        <div>
          <CardTitle id="med-schedule-title">Schedule</CardTitle>
          <p className="mt-1 text-base text-ink">
            Times are your local clock times ({timeZone.replaceAll('_', ' ')}) and stay correct when the clocks change.
          </p>
        </div>

        <fieldset className="min-w-0">
          <legend className="mb-2 text-sm font-semibold text-ink">Times of day</legend>
          {values.times.length > 0 && (
            <ul aria-label="Chosen times" className="mb-4 flex flex-wrap gap-2">
              {values.times.map((time) => (
                <li key={time} className="inline-flex min-h-11 items-center gap-1 rounded-full bg-sage-tint pl-4 pr-1 text-base font-semibold text-sage-dark">
                  {time}
                  <button
                    type="button"
                    aria-label={`Remove ${time}`}
                    onClick={() => update('times', values.times.filter((t) => t !== time), 'times')}
                    className="flex h-9 w-9 items-center justify-center rounded-full transition duration-150 hover:bg-surface"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <Input
                id="med-time-input"
                label="Add a time"
                type="time"
                value={newTime}
                onChange={(e) => {
                  setNewTime(e.target.value)
                  setTimeError(undefined)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault() // adding a time must not submit the whole form
                    addTimeFromInput()
                  }
                }}
                error={timeError}
              />
            </div>
            <Button type="button" variant="secondary" className="mt-7" onClick={addTimeFromInput}>
              Add time
            </Button>
          </div>
          {errors.times && <p className="mt-2 text-sm font-medium text-danger">{errors.times}</p>}
        </fieldset>

        <fieldset className="min-w-0">
          <legend className="mb-2 text-sm font-semibold text-ink">Days of the week</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => {
              const selected = values.days.includes(day.value)
              return (
                <button
                  key={day.value}
                  id={`day-${day.value}`}
                  type="button"
                  aria-pressed={selected}
                  aria-label={day.long}
                  onClick={() => toggleDay(day.value)}
                  className={cx(
                    'min-h-11 min-w-14 rounded-2xl border px-3 text-base font-semibold transition duration-150',
                    selected ? 'border-sage-dark bg-sage-dark text-surface' : 'border-sage bg-surface text-ink hover:bg-sage-tint',
                  )}
                >
                  {day.short}
                </button>
              )
            })}
          </div>
          {errors.days && <p className="mt-2 text-sm font-medium text-danger">{errors.days}</p>}
        </fieldset>

        {otherSchedules > 0 && (
          <p className="rounded-2xl bg-subtle p-4 text-base text-ink">
            This medication has {otherSchedules} more schedule{otherSchedules === 1 ? '' : 's'}. They are kept as they are; only the first can be edited here.
          </p>
        )}
      </Card>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <ButtonLink to="/medications" variant="ghost">
          Cancel
        </ButtonLink>
        <Button type="submit" loading={busy}>
          {mode === 'create' ? 'Add medication' : 'Save changes'}
        </Button>
      </div>
    </form>
  )
}
