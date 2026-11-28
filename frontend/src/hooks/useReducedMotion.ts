import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  const media = window.matchMedia(QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function snapshot(): boolean {
  // Where the question cannot be asked (old browsers, tests) the calm answer is "no animation".
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia(QUERY).matches
}

/**
 * True when the person asked their system for reduced motion. JavaScript-driven animation (the donut sweep, the
 * number count-up, chart bars) must check this: CSS animations are already switched off globally in index.css.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true)
}
