import { describe, expect, it } from 'vitest'
import type { Medication, Schedule } from '../api/types'
import {
  addTime, daysSummary, emptyValues, mapApiErrors, scheduleSummary, toMedicationPayload, toSchedulePayload,
  validateMedication, valuesFromMedication, type MedicationFormValues,
} from './medications'

const TODAY = '2026-11-25'
const valid = (overrides: Partial<MedicationFormValues> = {}): MedicationFormValues => ({
  ...emptyValues(TODAY), name: 'Metformin', dosage: '500 mg', times: ['08:00', '20:00'], ...overrides,
})

describe('validateMedication', () => {
  it('accepts a complete form', () => {
    expect(validateMedication(valid(), TODAY)).toEqual({})
  })

  it('starts empty with every day selected and today as the start date', () => {
    expect(emptyValues(TODAY)).toMatchObject({ startDate: TODAY, days: [0, 1, 2, 3, 4, 5, 6], times: [], endDate: '' })
  })

  it('requires a name and a dosage (and treats spaces as empty)', () => {
    expect(validateMedication(valid({ name: '   ', dosage: '' }), TODAY)).toEqual({
      name: 'Enter the medication name.', dosage: 'Enter the dosage, for example 500 mg.',
    })
  })

  it('limits name and dosage to 200 characters, like the API', () => {
    const errors = validateMedication(valid({ name: 'x'.repeat(201), dosage: 'y'.repeat(201) }), TODAY)
    expect(errors.name).toMatch(/200/)
    expect(errors.dosage).toMatch(/200/)
    expect(validateMedication(valid({ name: 'x'.repeat(200) }), TODAY).name).toBeUndefined()
  })

  it('requires a real start date', () => {
    expect(validateMedication(valid({ startDate: '' }), TODAY).startDate).toBe('Choose a start date.')
    expect(validateMedication(valid({ startDate: '2026-02-31' }), TODAY).startDate).toBe('Enter a valid start date.')
  })

  describe('end date', () => {
    it('is optional', () => {
      expect(validateMedication(valid({ endDate: '' }), TODAY).endDate).toBeUndefined()
    })
    it('cannot be before the start date', () => {
      expect(validateMedication(valid({ startDate: '2026-12-10', endDate: '2026-12-01' }), TODAY).endDate).toBe('The end date cannot be before the start date.')
    })
    it('may equal the start date, and today is allowed', () => {
      expect(validateMedication(valid({ startDate: TODAY, endDate: TODAY }), TODAY).endDate).toBeUndefined()
    })
    it('cannot be in the past', () => {
      expect(validateMedication(valid({ startDate: '2026-11-01', endDate: '2026-11-20' }), TODAY).endDate).toBe('The end date cannot be in the past.')
    })
    it('an unchanged past end date is allowed when editing (the API allows it)', () => {
      const values = valid({ startDate: '2026-11-01', endDate: '2026-11-20' })
      expect(validateMedication(values, TODAY, '2026-11-20').endDate).toBeUndefined()
      expect(validateMedication({ ...values, endDate: '2026-11-21' }, TODAY, '2026-11-20').endDate).toBe('The end date cannot be in the past.')
    })
    it('must be a real date', () => {
      expect(validateMedication(valid({ endDate: '2026-02-30' }), TODAY).endDate).toBe('Enter a valid end date.')
    })
  })

  describe('times of day', () => {
    it('needs at least one', () => {
      expect(validateMedication(valid({ times: [] }), TODAY).times).toBe('Add at least one time of day.')
    })
    it('rejects duplicates and malformed values (defence in depth: the UI prevents them)', () => {
      expect(validateMedication(valid({ times: ['08:00', '08:00'] }), TODAY).times).toBe('Each time can only be listed once.')
      expect(validateMedication(valid({ times: ['25:00'] }), TODAY).times).toBe('Every time must look like 08:00.')
    })
  })

  it('needs at least one day', () => {
    expect(validateMedication(valid({ days: [] }), TODAY).days).toBe('Choose at least one day.')
    expect(validateMedication(valid({ days: [2] }), TODAY).days).toBeUndefined()
  })

  it('reports every problem at once', () => {
    const errors = validateMedication({ ...emptyValues(TODAY), days: [] }, TODAY)
    expect(Object.keys(errors).sort()).toEqual(['days', 'dosage', 'name', 'times'])
  })
})

describe('addTime', () => {
  it('adds, keeps the list sorted, and returns a new array', () => {
    const first = addTime([], '20:00').times
    const second = addTime(first, '08:00')
    expect(second.times).toEqual(['08:00', '20:00'])
    expect(second.error).toBeUndefined()
    expect(first).toEqual(['20:00'])
  })
  it('refuses duplicates, blanks and malformed times with a clear message', () => {
    expect(addTime(['08:00'], '08:00')).toEqual({ times: ['08:00'], error: '08:00 is already in the list.' })
    expect(addTime([], '').error).toBe('Choose a time first.')
    expect(addTime([], '8:00').error).toBe('Enter a time like 08:00.')
    expect(addTime([], '24:00').error).toBe('Enter a time like 08:00.')
  })
})

describe('payloads', () => {
  it('trims text, sends null for no end date, and sorts times and days', () => {
    const values = valid({ name: ' Metformin ', instructions: ' With food ', times: ['20:00', '08:00'], days: [4, 0, 2] })
    expect(toMedicationPayload(values)).toEqual({ name: 'Metformin', dosage: '500 mg', instructions: 'With food', start_date: TODAY, end_date: null })
    expect(toSchedulePayload(values)).toEqual({ times_of_day: ['08:00', '20:00'], days_of_week: [0, 2, 4], start_date: TODAY, end_date: null })
  })
  it('the schedule shares the medication end date', () => {
    expect(toSchedulePayload(valid({ endDate: '2026-12-31' })).end_date).toBe('2026-12-31')
    expect(toMedicationPayload(valid({ endDate: '2026-12-31' })).end_date).toBe('2026-12-31')
  })
})

describe('mapApiErrors', () => {
  it('maps API field names onto form fields', () => {
    expect(mapApiErrors({ name: 'a', dosage: 'b', start_date: 'c', end_date: 'd', times_of_day: 'e', days_of_week: 'f', instructions: 'g' })).toEqual({
      name: 'a', dosage: 'b', startDate: 'c', endDate: 'd', times: 'e', days: 'f', instructions: 'g',
    })
  })
  it('turns unknown fields and non-field errors into a general message', () => {
    expect(mapApiErrors({ surprise: 'Oops' })).toEqual({ form: 'Oops' })
    expect(mapApiErrors({ non_field_errors: 'Bad.' })).toEqual({ form: 'Bad.' })
  })
  it('uses the fallback only when there is nothing field-specific', () => {
    expect(mapApiErrors({}, 'Server down')).toEqual({ form: 'Server down' })
    expect(mapApiErrors({ name: 'x' }, 'Server down')).toEqual({ name: 'x' })
  })
})

describe('reading a saved medication', () => {
  const medication: Medication = { id: 1, name: 'Aspirin', dosage: '75 mg', instructions: 'After lunch', start_date: '2026-11-01', end_date: null, is_active: true }
  const schedule: Schedule = { id: 5, times_of_day: ['20:00:00', '08:00'], days_of_week: [4, 0], start_date: '2026-11-01', end_date: null, is_active: true }

  it('turns a medication and schedule into form values', () => {
    expect(valuesFromMedication(medication, schedule)).toEqual({
      name: 'Aspirin', dosage: '75 mg', instructions: 'After lunch', startDate: '2026-11-01', endDate: '', times: ['20:00', '08:00'], days: [0, 4],
    })
  })
  it('without a schedule: no times, every day', () => {
    expect(valuesFromMedication(medication)).toMatchObject({ times: [], days: [0, 1, 2, 3, 4, 5, 6] })
  })
  it.each([
    [[0, 1, 2, 3, 4, 5, 6], 'Every day'], [[4, 3, 2, 1, 0], 'Weekdays'], [[6, 5], 'Weekends'], [[4, 0, 2], 'Mon, Wed, Fri'], [[3], 'Thu'],
  ])('summarises days %j as "%s"', (days, text) => {
    expect(daysSummary(days)).toBe(text)
  })
  it('summarises a schedule for the list', () => {
    expect(scheduleSummary(schedule)).toEqual({ times: ['08:00', '20:00'], days: 'Mon, Fri' })
  })
})
