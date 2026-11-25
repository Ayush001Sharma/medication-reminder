import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCountUp } from './useCountUp'
import { usePrefersReducedMotion } from './useReducedMotion'

/** A controllable stand-in for window.matchMedia. */
function stubMotionPreference(reduce: boolean) {
  const listeners = new Set<() => void>()
  let matches = reduce
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') ? matches : false,
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }))
  return {
    change(next: boolean) {
      matches = next
      listeners.forEach((listener) => listener())
    },
    listeners,
  }
}

afterEach(() => vi.useRealTimers())

describe('usePrefersReducedMotion', () => {
  it('is true where the browser cannot say (so nothing animates by surprise)', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(renderHook(() => usePrefersReducedMotion()).result.current).toBe(true)
  })

  it('follows the system setting, including a change while the page is open, and cleans up', () => {
    const media = stubMotionPreference(false)
    const { result, unmount } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(false)
    act(() => media.change(true))
    expect(result.current).toBe(true)
    unmount()
    expect(media.listeners.size).toBe(0)
  })
})

describe('useCountUp', () => {
  it('is simply the target, with no animation frames at all, when disabled', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { result } = renderHook(() => useCountUp(95, false))
    expect(result.current).toBe(95)
    expect(raf).not.toHaveBeenCalled()
  })

  it('climbs from 0 to the target, easing out, then stops', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const { result } = renderHook(() => useCountUp(80, true, 1000))
    expect(result.current).toBe(0)
    act(() => void vi.advanceTimersByTime(500))
    expect(result.current).toBeGreaterThan(40) // ease-out: past halfway at half time
    expect(result.current).toBeLessThan(80)
    act(() => void vi.advanceTimersByTime(600))
    expect(result.current).toBe(80)
  })

  it('stops its frames when the component goes away', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const { unmount } = renderHook(() => useCountUp(50, true))
    unmount()
    expect(cancel).toHaveBeenCalled()
  })
})
