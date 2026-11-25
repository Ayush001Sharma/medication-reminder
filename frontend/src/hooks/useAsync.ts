import { useCallback, useEffect, useRef, useState } from 'react'

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'success'; data: T; /** true while a reload() is fetching fresh data; `data` is the previous result */ refreshing: boolean }
  | { status: 'error'; error: unknown }

type Settled<T> = { status: 'success'; data: T } | { status: 'error'; error: unknown }

/**
 * Run an async function when the component mounts (or when `key` changes) and track loading / success / error.
 * Aborts the request when the component goes away and ignores answers for an outdated key.
 *
 * `reload()` fetches again WITHOUT throwing the screen back to a skeleton: the previous data stays visible with
 * `refreshing: true` until the new data arrives. A different `key` (a different resource) does show loading.
 */
export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>, key = ''): AsyncState<T> & { reload: () => void } {
  const loadRef = useRef(load)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; attempt: number; state: Settled<T> } | null>(null)

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

  let current: AsyncState<T>
  if (!result || result.key !== key) current = { status: 'loading' }
  else if (result.attempt === attempt) current = result.state.status === 'success' ? { status: 'success', data: result.state.data, refreshing: false } : result.state
  else current = result.state.status === 'success' ? { status: 'success', data: result.state.data, refreshing: true } : { status: 'loading' }
  return { ...current, reload }
}
