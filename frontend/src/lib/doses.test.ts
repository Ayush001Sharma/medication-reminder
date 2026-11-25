import { describe, expect, it } from 'vitest'
import type { Dose, DoseStatus } from '../api/types'
import { canSkip, canTake, conflictMessage, countTaken, dayPartOf, groupByDay, groupByDayPart, localTimeOf, optimisticDose } from './doses'

let nextId = 1
const dose = (local: string, status: DoseStatus = 'pending', overrides: Partial<Dose> = {}): Dose => ({
  id: nextId++,
  medication: { id: 1, name: 'Metformin', dosage: '500 mg', instructions: '' },
  // scheduled_at only needs to sort the same way as the local time within these tests
  scheduled_at: `${local.slice(0, 10)}T${local.slice(11, 16)}:00Z`,
  scheduled_local: `${local}:00+05:30`,
  status,
  taken_late: false,
  taken_at: null,
  ...overrides,
})

describe('day parts', () => {
  it.each([
    ['2026-11-25T00:00', 'morning'],
    ['2026-11-25T05:59', 'morning'],
    ['2026-11-25T11:59', 'morning'],
    ['2026-11-25T12:00', 'afternoon'],
    ['2026-11-25T16:59', 'afternoon'],
    ['2026-11-25T17:00', 'evening'],
    ['2026-11-25T20:59', 'evening'],
    ['2026-11-25T21:00', 'night'],
    ['2026-11-25T23:59', 'night'],
  ])('%s is %s', (local, part) => {
    expect(dayPartOf(dose(local))).toBe(part)
  })

  it('groups in day order, sorts each group by time, and leaves out empty groups', () => {
    const groups = groupByDayPart([dose('2026-11-25T20:00'), dose('2026-11-25T08:30'), dose('2026-11-25T07:00'), dose('2026-11-25T22:15')])
    expect(groups.map((g) => g.part.label)).toEqual(['Morning', 'Evening', 'Night'])
    expect(groups[0]?.doses.map(localTimeOf)).toEqual(['07:00', '08:30'])
  })

  it('has no groups for no doses', () => {
    expect(groupByDayPart([])).toEqual([])
  })
})

describe('grouping by day', () => {
  it('groups by local date, oldest first, each day in time order', () => {
    const groups = groupByDay([dose('2026-11-27T08:00'), dose('2026-11-26T20:00'), dose('2026-11-26T08:00'), dose('2026-11-28T09:00')])
    expect(groups.map((g) => g.date)).toEqual(['2026-11-26', '2026-11-27', '2026-11-28'])
    expect(groups[0]?.doses.map(localTimeOf)).toEqual(['08:00', '20:00'])
  })

  it('uses the LOCAL date, not the UTC date', () => {
    // 20:00 local on the 26th is the 26th even though the UTC instant could be a different date
    const late = dose('2026-11-26T23:30', 'pending', { scheduled_at: '2026-11-26T18:00:00Z' })
    expect(groupByDay([late])[0]?.date).toBe('2026-11-26')
  })
})

describe('which actions the API allows', () => {
  it.each<[DoseStatus, boolean, boolean]>([
    ['pending', true, true],
    ['reminded', true, true],
    ['missed', true, false], // a missed dose can be taken late but not skipped
    ['taken', false, false],
    ['skipped', false, false],
  ])('%s: take=%s skip=%s', (status, take, skip) => {
    expect(canTake(dose('2026-11-25T08:00', status))).toBe(take)
    expect(canSkip(dose('2026-11-25T08:00', status))).toBe(skip)
  })
})

describe('optimistic result', () => {
  const now = new Date('2026-11-25T03:00:00Z')

  it('taken: status, time, and not late for a normal dose', () => {
    expect(optimisticDose(dose('2026-11-25T08:00', 'reminded'), 'taken', now)).toMatchObject({ status: 'taken', taken_at: now.toISOString(), taken_late: false })
  })

  it('taking a MISSED dose makes it "taken late"', () => {
    expect(optimisticDose(dose('2026-11-25T08:00', 'missed'), 'taken', now)).toMatchObject({ status: 'taken', taken_late: true })
  })

  it('skip: only the status changes', () => {
    const before = dose('2026-11-25T08:00')
    expect(optimisticDose(before, 'skip', now)).toEqual({ ...before, status: 'skipped' })
  })

  it('does not mutate the original', () => {
    const before = dose('2026-11-25T08:00')
    optimisticDose(before, 'taken', now)
    expect(before.status).toBe('pending')
  })
})

describe('409 conflict wording', () => {
  it.each([
    ['A taken dose cannot be marked skipped.', 'skip', "That dose is already marked as taken, so it can't be skipped."],
    ['A skipped dose cannot be marked taken.', 'taken', "That dose is already marked as skipped, so it can't be marked as taken."],
    ['A missed dose cannot be marked skipped.', 'skip', "That dose is already marked as missed, so it can't be skipped."],
  ] as const)('%s', (detail, action, expected) => {
    expect(conflictMessage(detail, action)).toBe(`${expected} We've refreshed the list.`)
  })

  it('has a safe fallback for any other wording', () => {
    expect(conflictMessage('Something else', 'taken')).toBe("This dose has already changed, so it can't be marked as taken. We've refreshed the list.")
  })
})

it('counts taken doses', () => {
  expect(countTaken([dose('2026-11-25T08:00', 'taken'), dose('2026-11-25T12:00'), dose('2026-11-25T20:00', 'taken')])).toEqual({ taken: 2, total: 3 })
})
