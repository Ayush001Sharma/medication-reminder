/**
 * Calendar dates are plain "YYYY-MM-DD" strings in the PATIENT'S timezone. Everything here avoids the local
 * timezone of the browser and avoids Intl's locale-dependent date wording, so the same input gives the same
 * output on every machine (and in tests).
 */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function parts(isoDate: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(isoDate)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return real ? { year, month, day } : null
}

export function isIsoDate(value: string): boolean {
  return parts(value) !== null
}

/** Today's date in the given IANA timezone (falls back to UTC for an unknown zone). */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
  }
  const get = (type: string) => formatter.formatToParts(now).find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function addDays(isoDate: string, days: number): string {
  const p = parts(isoDate)
  if (!p) return isoDate
  return new Date(Date.UTC(p.year, p.month - 1, p.day + days)).toISOString().slice(0, 10)
}

/** "Wednesday, 25 November" */
export function longDate(isoDate: string): string {
  const p = parts(isoDate)
  if (!p) return isoDate
  const weekday = WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]
  return `${weekday}, ${p.day} ${MONTHS[p.month - 1]}`
}

/** "25 Nov 2026" */
export function shortDate(isoDate: string): string {
  const p = parts(isoDate)
  if (!p) return isoDate
  return `${p.day} ${MONTHS[p.month - 1]?.slice(0, 3)} ${p.year}`
}

/** "Today", "Tomorrow", or "Friday, 27 November" relative to `today`. */
export function dayHeading(isoDate: string, today: string): string {
  if (isoDate === today) return 'Today'
  if (isoDate === addDays(today, 1)) return 'Tomorrow'
  return longDate(isoDate)
}

/** The wall-clock time "HH:MM" of an instant, in the given timezone. */
export function timeInZone(isoInstant: string, timeZone: string): string {
  const date = new Date(isoInstant)
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  } catch {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  }
  return formatter.format(date)
}

/** The patient's timezone from their profile, or UTC. */
export function zoneOf(profile: { timezone: string } | null | undefined): string {
  return profile?.timezone || 'UTC'
}

/** How many calendar days lie in an inclusive range ("2026-11-01" to "2026-11-01" is 1). */
export function daysInRange(from: string, to: string): number {
  const a = parts(from)
  const b = parts(to)
  if (!a || !b) return Number.NaN
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000) + 1
}

/** "25 Nov 2026, 14:05": an instant written in the given timezone. */
export function formatInstant(isoInstant: string, timeZone: string): string {
  const date = new Date(isoInstant)
  if (Number.isNaN(date.getTime())) return isoInstant
  return `${shortDate(todayInZone(timeZone, date))}, ${timeInZone(isoInstant, timeZone)}`
}

/** "25 Nov 2026": the calendar date of an instant in the given timezone. */
export function dateOfInstant(isoInstant: string, timeZone: string): string {
  const date = new Date(isoInstant)
  return Number.isNaN(date.getTime()) ? isoInstant : shortDate(todayInZone(timeZone, date))
}
