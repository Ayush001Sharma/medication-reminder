import { useEffect, useRef, useState } from 'react'

/**
 * The width of an element in pixels, kept up to date as it resizes. Charts need a number; until the real width is
 * known (and in tests, where nothing has a layout) the fallback is used so the chart still renders.
 */
export function useElementWidth<T extends HTMLElement>(fallback = 320) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    // The observer reports the initial size straight after observe(), so no separate first measurement is needed.
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.floor(entry?.contentRect.width ?? 0)
      if (next > 0) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}
