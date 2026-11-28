import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { daysInRange, dateOfInstant, formatInstant } from './dates'
import { displayName, isNoAccess, isPatientId, MAX_REPORT_DAYS, roleLabel, shortLabel, validateRange } from './report'

describe('validateRange', () => {
  it('accepts a normal range and a single day', () => {
    expect(validateRange('2026-11-01', '2026-11-25')).toEqual({})
    expect(validateRange('2026-11-01', '2026-11-01')).toEqual({})
  })
  it('allows exactly 366 days and refuses 367', () => {
    expect(MAX_REPORT_DAYS).toBe(366)
    expect(validateRange('2025-11-26', '2026-11-26')).toEqual({}) // 366 days inclusive
    expect(validateRange('2025-11-25', '2026-11-26')).toEqual({ to: 'Pick at most 366 days (this is 367).' })
  })
  it('counts a leap year correctly', () => {
    expect(validateRange('2024-01-01', '2024-12-31')).toEqual({}) // 366 days
    expect(validateRange('2024-01-01', '2025-01-01').to).toMatch(/367/)
  })
  it('refuses an end before the start, and missing or invalid dates', () => {
    expect(validateRange('2026-11-25', '2026-11-24')).toEqual({ to: 'The end date must not be before the start date.' })
    expect(validateRange('', '2026-11-24')).toEqual({ from: 'Choose a start date.' })
    expect(validateRange('2026-11-24', '')).toEqual({ to: 'Choose an end date.' })
    expect(validateRange('2026-02-30', '2026-03-01')).toEqual({ from: 'Enter a valid start date.' })
    expect(validateRange('', '')).toEqual({ from: 'Choose a start date.', to: 'Choose an end date.' })
  })
})

describe('isNoAccess', () => {
  it('is true for 404 and for a 400 about the patient id, false for everything else', () => {
    expect(isNoAccess(new ApiError(404, 'x'))).toBe(true)
    expect(isNoAccess(new ApiError(400, 'x', { patient: 'Must be a whole number.' }))).toBe(true)
    expect(isNoAccess(new ApiError(400, 'x', { to: 'bad range' }))).toBe(false)
    expect(isNoAccess(new ApiError(403, 'x'))).toBe(false)
    expect(isNoAccess(new ApiError(500, 'x'))).toBe(false)
    expect(isNoAccess(new Error('x'))).toBe(false)
  })
})

describe('small helpers', () => {
  it('displayName falls back to the email', () => {
    expect(displayName({ full_name: 'Priya', email: 'p@x.com' })).toBe('Priya')
    expect(displayName({ full_name: '  ', email: 'p@x.com' })).toBe('p@x.com')
  })
  it('roleLabel capitalises', () => {
    expect(roleLabel('caregiver')).toBe('Caregiver')
    expect(roleLabel('')).toBe('')
  })
  it('isPatientId needs a whole number', () => {
    expect(isPatientId('7')).toBe(true)
    for (const bad of ['', 'abc', '7a', '-1', '1.5', ' 7']) expect(isPatientId(bad)).toBe(false)
  })
  it('shortLabel shortens long names only', () => {
    expect(shortLabel('Metformin')).toBe('Metformin')
    expect(shortLabel('Metformin extended release')).toBe('Metformin exten…')
  })
})

describe('date helpers for the new screens', () => {
  it('daysInRange is inclusive', () => {
    expect(daysInRange('2026-11-01', '2026-11-01')).toBe(1)
    expect(daysInRange('2026-11-01', '2026-11-30')).toBe(30)
    expect(daysInRange('2026-11-30', '2026-11-01')).toBe(-28)
    expect(daysInRange('nope', '2026-11-01')).toBeNaN()
  })
  it('formats an instant in the given timezone, including a date change', () => {
    expect(formatInstant('2026-11-24T22:00:00Z', 'Asia/Kolkata')).toBe('25 Nov 2026, 03:30')
    expect(formatInstant('2026-11-24T22:00:00Z', 'America/New_York')).toBe('24 Nov 2026, 17:00')
    expect(dateOfInstant('2026-11-24T22:00:00Z', 'Asia/Kolkata')).toBe('25 Nov 2026')
    expect(formatInstant('garbage', 'UTC')).toBe('garbage')
  })
})
