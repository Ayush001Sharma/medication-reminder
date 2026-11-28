import { describe, expect, it } from 'vitest'
import { addDays, dayHeading, isIsoDate, longDate, shortDate, timeInZone, todayInZone, zoneOf } from './dates'

describe('calendar dates', () => {
  it('validates real calendar dates only', () => {
    expect(isIsoDate('2026-11-25')).toBe(true)
    expect(isIsoDate('2028-02-29')).toBe(true) // leap year
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '25-11-2026', '', 'nope']) expect(isIsoDate(bad)).toBe(false)
  })

  it('formats long and short dates without depending on the machine locale', () => {
    expect(longDate('2026-11-25')).toBe('Wednesday, 25 November')
    expect(longDate('2026-01-01')).toBe('Thursday, 1 January')
    expect(shortDate('2026-11-05')).toBe('5 Nov 2026')
    expect(longDate('garbage')).toBe('garbage')
  })

  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('labels today and tomorrow, and spells out other days', () => {
    expect(dayHeading('2026-11-25', '2026-11-25')).toBe('Today')
    expect(dayHeading('2026-11-26', '2026-11-25')).toBe('Tomorrow')
    expect(dayHeading('2026-11-27', '2026-11-25')).toBe('Friday, 27 November')
    expect(dayHeading('2026-12-01', '2026-11-30')).toBe('Tomorrow') // across a month end
  })
})

describe('timezones', () => {
  const instant = new Date('2026-11-24T20:00:00Z')
  it("finds today's date in the patient's zone, which can differ from UTC", () => {
    expect(todayInZone('UTC', instant)).toBe('2026-11-24')
    expect(todayInZone('Asia/Kolkata', instant)).toBe('2026-11-25') // 01:30 the next day
    expect(todayInZone('America/Los_Angeles', instant)).toBe('2026-11-24')
    expect(todayInZone('Pacific/Kiritimati', new Date('2026-11-24T11:00:00Z'))).toBe('2026-11-25') // UTC+14
  })

  it('falls back to UTC for a zone the browser does not know', () => {
    expect(todayInZone('Mars/Olympus', instant)).toBe('2026-11-24')
    expect(timeInZone('2026-11-24T20:00:00Z', 'Mars/Olympus')).toBe('20:00')
  })

  it('shows an instant as local wall-clock time, including across daylight saving', () => {
    expect(timeInZone('2026-11-25T02:30:00Z', 'Asia/Kolkata')).toBe('08:00')
    expect(timeInZone('2026-07-01T12:00:00Z', 'America/New_York')).toBe('08:00') // EDT
    expect(timeInZone('2026-12-01T13:00:00Z', 'America/New_York')).toBe('08:00') // EST
    expect(timeInZone('2026-11-25T00:05:00Z', 'UTC')).toBe('00:05') // midnight hour is 00, not 24
  })

  it('reads the zone from a profile, or UTC', () => {
    expect(zoneOf({ timezone: 'Asia/Kolkata' })).toBe('Asia/Kolkata')
    expect(zoneOf(null)).toBe('UTC')
    expect(zoneOf(undefined)).toBe('UTC')
    expect(zoneOf({ timezone: '' })).toBe('UTC')
  })
})
