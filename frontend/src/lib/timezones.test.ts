import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalZone, timezoneOptions } from './timezones'

describe('timezones', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renames legacy browser names to current IANA names', () => {
    expect(canonicalZone('Asia/Calcutta')).toBe('Asia/Kolkata')
    expect(canonicalZone('Europe/Kiev')).toBe('Europe/Kyiv')
    expect(canonicalZone('America/New_York')).toBe('America/New_York')
  })

  it('offers Asia/Kolkata (never the legacy Asia/Calcutta), UTC, no duplicates, sorted', () => {
    const { all } = timezoneOptions()
    expect(all).toContain('Asia/Kolkata')
    expect(all).toContain('UTC')
    expect(all).not.toContain('Asia/Calcutta')
    expect(new Set(all).size).toBe(all.length)
    expect(all).toEqual([...all].sort((a, b) => a.localeCompare(b)))
  })

  it('defaults to the browser zone under its current name, even if the browser lists it only by the old name', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Calcutta' }) }) as unknown as Intl.DateTimeFormat,
    )
    expect(timezoneOptions().detected).toBe('Asia/Kolkata')
  })

  it('falls back to a short list when the browser cannot enumerate zones', () => {
    const original = Intl.supportedValuesOf
    // @ts-expect-error simulate an older browser
    Intl.supportedValuesOf = undefined
    try {
      expect(timezoneOptions().all).toEqual(expect.arrayContaining(['UTC', 'Asia/Kolkata', 'America/New_York']))
    } finally {
      Intl.supportedValuesOf = original
    }
  })
})
