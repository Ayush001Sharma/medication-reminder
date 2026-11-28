import { ApiError } from '../api/client'
import { daysInRange, isIsoDate } from './dates'

/** The most days one report may cover (the API enforces the same limit). */
export const MAX_REPORT_DAYS = 366

/** Shown in the info tooltip next to the adherence percentage. */
export const ADHERENCE_DEFINITION =
  'Adherence = taken ÷ (taken + missed). Late doses count as taken. Skipped doses are shown separately and are not counted, ' +
  'and neither are doses that are not due yet.'

export interface RangeErrors {
  from?: string
  to?: string
}

/** Check a from/to pair typed into the date range picker. Returns an empty object when it is fine. */
export function validateRange(from: string, to: string): RangeErrors {
  const errors: RangeErrors = {}
  if (!from) errors.from = 'Choose a start date.'
  else if (!isIsoDate(from)) errors.from = 'Enter a valid start date.'
  if (!to) errors.to = 'Choose an end date.'
  else if (!isIsoDate(to)) errors.to = 'Enter a valid end date.'
  if (errors.from || errors.to) return errors

  const days = daysInRange(from, to)
  if (days < 1) errors.to = 'The end date must not be before the start date.'
  else if (days > MAX_REPORT_DAYS) errors.to = `Pick at most ${MAX_REPORT_DAYS} days (this is ${days}).`
  return errors
}

/** A person's name, or their email when they have not given one. */
export function displayName(person: { full_name: string; email: string }): string {
  return person.full_name.trim() || person.email
}

/** "caregiver" -> "Caregiver" */
export function roleLabel(role: string): string {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : ''
}

/** A route parameter is a usable patient id only if it is a whole number. */
export function isPatientId(value: string): boolean {
  return /^\d+$/.test(value)
}

/** Short names on a chart axis: "Metformin extended release" -> "Metformin extende…" */
export function shortLabel(name: string, max = 16): string {
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name
}

/** "No access": the API answers 404 for a revoked, never-granted or unknown patient (and 400 for a malformed id). */
export function isNoAccess(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || (error.status === 400 && 'patient' in error.fieldErrors))
}
