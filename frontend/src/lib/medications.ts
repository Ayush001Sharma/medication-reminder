import type { Medication, MedicationWithSchedules, Schedule } from '../api/types'
import { isIsoDate } from './dates'

/** 0 = Monday ... 6 = Sunday, as the API numbers them. */
export const WEEKDAYS = [
  { value: 0, short: 'Mon', long: 'Monday' },
  { value: 1, short: 'Tue', long: 'Tuesday' },
  { value: 2, short: 'Wed', long: 'Wednesday' },
  { value: 3, short: 'Thu', long: 'Thursday' },
  { value: 4, short: 'Fri', long: 'Friday' },
  { value: 5, short: 'Sat', long: 'Saturday' },
  { value: 6, short: 'Sun', long: 'Sunday' },
] as const

export const ALL_DAYS: number[] = [0, 1, 2, 3, 4, 5, 6]

export interface MedicationFormValues {
  name: string
  dosage: string
  instructions: string
  startDate: string
  /** Empty string means no end date. */
  endDate: string
  /** "HH:MM", local time. */
  times: string[]
  days: number[]
}

export type FormField = 'name' | 'dosage' | 'instructions' | 'startDate' | 'endDate' | 'times' | 'days' | 'form'
export type FormErrors = Partial<Record<FormField, string>>

export function emptyValues(today: string): MedicationFormValues {
  return { name: '', dosage: '', instructions: '', startDate: today, endDate: '', times: [], days: [...ALL_DAYS] }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function isValidTime(value: string): boolean {
  return TIME.test(value)
}

/** Adds a time, keeping the list sorted and free of duplicates. Returns an error message instead when it cannot. */
export function addTime(times: string[], raw: string): { times: string[]; error?: string } {
  const value = raw.trim()
  if (!value) return { times, error: 'Choose a time first.' }
  if (!isValidTime(value)) return { times, error: 'Enter a time like 08:00.' }
  if (times.includes(value)) return { times, error: `${value} is already in the list.` }
  return { times: [...times, value].sort() }
}

/**
 * The same rules the API enforces, so mistakes show up before a round trip. The API still has the final say and
 * its messages are shown too. `originalEndDate` lets an already-expired end date stay as it is when editing
 * (the API allows an unchanged end date in the past).
 */
export function validateMedication(values: MedicationFormValues, today: string, originalEndDate: string | null = null): FormErrors {
  const errors: FormErrors = {}
  const name = values.name.trim()
  if (!name) errors.name = 'Enter the medication name.'
  else if (name.length > 200) errors.name = 'Keep the name under 200 characters.'

  const dosage = values.dosage.trim()
  if (!dosage) errors.dosage = 'Enter the dosage, for example 500 mg.'
  else if (dosage.length > 200) errors.dosage = 'Keep the dosage under 200 characters.'

  if (!values.startDate) errors.startDate = 'Choose a start date.'
  else if (!isIsoDate(values.startDate)) errors.startDate = 'Enter a valid start date.'

  if (values.endDate) {
    if (!isIsoDate(values.endDate)) errors.endDate = 'Enter a valid end date.'
    else if (!errors.startDate && values.endDate < values.startDate) errors.endDate = 'The end date cannot be before the start date.'
    else if (values.endDate < today && values.endDate !== originalEndDate) errors.endDate = 'The end date cannot be in the past.'
  }

  if (values.times.length === 0) errors.times = 'Add at least one time of day.'
  else if (new Set(values.times).size !== values.times.length) errors.times = 'Each time can only be listed once.'
  else if (values.times.some((time) => !isValidTime(time))) errors.times = 'Every time must look like 08:00.'

  if (values.days.length === 0) errors.days = 'Choose at least one day.'
  return errors
}

export function toMedicationPayload(values: MedicationFormValues) {
  return {
    name: values.name.trim(),
    dosage: values.dosage.trim(),
    instructions: values.instructions.trim(),
    start_date: values.startDate,
    end_date: values.endDate || null,
  }
}

/** The schedule shares the medication's start and end dates. */
export function toSchedulePayload(values: MedicationFormValues) {
  return {
    times_of_day: [...values.times].sort(),
    days_of_week: [...values.days].sort((a, b) => a - b),
    start_date: values.startDate,
    end_date: values.endDate || null,
  }
}

const API_FIELD_TO_FORM: Record<string, FormField> = {
  name: 'name',
  dosage: 'dosage',
  instructions: 'instructions',
  start_date: 'startDate',
  end_date: 'endDate',
  times_of_day: 'times',
  days_of_week: 'days',
  non_field_errors: 'form',
  detail: 'form',
}

/** Map the API's field names (snake_case) onto the form's fields. Unknown fields become a general message. */
export function mapApiErrors(fieldErrors: Record<string, string>, fallbackMessage?: string): FormErrors {
  const errors: FormErrors = {}
  for (const [field, message] of Object.entries(fieldErrors)) {
    errors[API_FIELD_TO_FORM[field] ?? 'form'] ??= message
  }
  if (Object.keys(errors).length === 0 && fallbackMessage) errors.form = fallbackMessage
  return errors
}

export function valuesFromMedication(medication: Medication, schedule?: Schedule): MedicationFormValues {
  return {
    name: medication.name,
    dosage: medication.dosage,
    instructions: medication.instructions,
    startDate: medication.start_date,
    endDate: medication.end_date ?? '',
    times: schedule ? schedule.times_of_day.map((time) => time.slice(0, 5)) : [],
    days: schedule ? [...schedule.days_of_week].sort((a, b) => a - b) : [...ALL_DAYS],
  }
}

/** "Every day", "Weekdays", "Weekends" or "Mon, Wed, Fri". */
export function daysSummary(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b).join(',')
  if (sorted === ALL_DAYS.join(',')) return 'Every day'
  if (sorted === '0,1,2,3,4') return 'Weekdays'
  if (sorted === '5,6') return 'Weekends'
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => WEEKDAYS[day]?.short)
    .join(', ')
}

/** Read-only view of one schedule for the list. Times keep their HH:MM form. */
export function scheduleSummary(schedule: Schedule): { times: string[]; days: string } {
  return { times: schedule.times_of_day.map((time) => time.slice(0, 5)).sort(), days: daysSummary(schedule.days_of_week) }
}

export function activeFirst(medications: MedicationWithSchedules[]): { active: MedicationWithSchedules[]; stopped: MedicationWithSchedules[] } {
  return { active: medications.filter((m) => m.is_active), stopped: medications.filter((m) => !m.is_active) }
}
