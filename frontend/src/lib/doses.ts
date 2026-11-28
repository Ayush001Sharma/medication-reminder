import type { Dose, DoseStatus } from '../api/types'

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night'
export type DoseAction = 'taken' | 'skip'

/** Morning includes the small hours so every day reads in clock order, with no group wrapping past midnight. */
export const DAY_PARTS: Array<{ id: DayPart; label: string; hours: string }> = [
  { id: 'morning', label: 'Morning', hours: 'until 12:00' },
  { id: 'afternoon', label: 'Afternoon', hours: '12:00 to 17:00' },
  { id: 'evening', label: 'Evening', hours: '17:00 to 21:00' },
  { id: 'night', label: 'Night', hours: 'from 21:00' },
]

/** The patient's local wall-clock time "HH:MM" of a dose. */
export function localTimeOf(dose: Dose): string {
  return dose.scheduled_local.slice(11, 16)
}

export function localDateOf(dose: Dose): string {
  return dose.scheduled_local.slice(0, 10)
}

export function dayPartOf(dose: Dose): DayPart {
  const hour = Number(dose.scheduled_local.slice(11, 13))
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  if (hour < 21) return 'evening'
  return 'night'
}

const byTime = (a: Dose, b: Dose) => a.scheduled_at.localeCompare(b.scheduled_at) || a.id - b.id

/** Non-empty day parts in order, doses in time order. */
export function groupByDayPart(doses: Dose[]): Array<{ part: (typeof DAY_PARTS)[number]; doses: Dose[] }> {
  return DAY_PARTS.map((part) => ({ part, doses: doses.filter((dose) => dayPartOf(dose) === part.id).sort(byTime) })).filter(
    (group) => group.doses.length > 0,
  )
}

/** Doses grouped by local calendar day, oldest day first. */
export function groupByDay(doses: Dose[]): Array<{ date: string; doses: Dose[] }> {
  const days = new Map<string, Dose[]>()
  for (const dose of [...doses].sort(byTime)) {
    const date = localDateOf(dose)
    days.set(date, [...(days.get(date) ?? []), dose])
  }
  return [...days.entries()].map(([date, list]) => ({ date, doses: list }))
}

/** What the API allows: pending, reminded and missed doses can be taken; only pending and reminded can be skipped. */
export function canTake(dose: Dose): boolean {
  return dose.status === 'pending' || dose.status === 'reminded' || dose.status === 'missed'
}

export function canSkip(dose: Dose): boolean {
  return dose.status === 'pending' || dose.status === 'reminded'
}

/** The dose as it will look once the server accepts the action. A missed dose taken now is "taken late". */
export function optimisticDose(dose: Dose, action: DoseAction, now: Date = new Date()): Dose {
  if (action === 'taken') {
    return { ...dose, status: 'taken', taken_at: now.toISOString(), taken_late: dose.status === 'missed' }
  }
  return { ...dose, status: 'skipped' }
}

const STATUS_WORDS: Record<DoseStatus, string> = {
  pending: 'still upcoming',
  reminded: 'waiting for you',
  taken: 'already marked as taken',
  missed: 'already marked as missed',
  skipped: 'already marked as skipped',
}

/**
 * A friendly sentence for the API's 409 ("A taken dose cannot be marked skipped."). The backend names the dose's
 * current status; we turn it into plain language and say what we did about it.
 */
export function conflictMessage(detail: string, action: DoseAction): string {
  const match = /^A (pending|reminded|taken|missed|skipped) dose cannot be marked (taken|skipped)\./.exec(detail)
  const verb = action === 'taken' ? 'marked as taken' : 'skipped'
  if (!match) return `This dose has already changed, so it can't be ${verb}. We've refreshed the list.`
  const status = match[1] as DoseStatus
  return `That dose is ${STATUS_WORDS[status]}, so it can't be ${verb}. We've refreshed the list.`
}

export function countTaken(doses: Dose[]): { taken: number; total: number } {
  return { taken: doses.filter((dose) => dose.status === 'taken').length, total: doses.length }
}
