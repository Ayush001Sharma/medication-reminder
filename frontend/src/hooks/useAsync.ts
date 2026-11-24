import { useCallback, useEffect, useRef, useState } from 'react'

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: unknown }

/**
 * Run an async function when the component mounts (or when `key` changes) and track loading / success / error.
 * Aborts the request when the component goes away, and ignores answers that arrive for an outdated key.
 * `reload()` runs it again.
 */
export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>, key = ''): AsyncState<T> & { reload: () => void } {
  const loadRef = useRef(load)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; attempt: number; state: AsyncState<T> } | null>(null)

  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    const controller = new AbortController()
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key, attempt, state: { status: 'success', data } })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setResult({ key, attempt, state: { status: 'error', error } })
      },
    )
    return () => controller.abort()
  }, [key, attempt])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])
  const current = result && result.key === key && result.attempt === attempt ? result.state : { status: 'loading' as const }
  return { ...current, reload }
}
