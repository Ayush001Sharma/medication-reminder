import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAsync } from './useAsync'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useAsync', () => {
  it('goes loading -> success with the data', async () => {
    const { result } = renderHook(() => useAsync(async () => 'hello'))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current).toMatchObject({ status: 'success', data: 'hello', refreshing: false })
  })

  it('goes loading -> error with the error', async () => {
    const failure = new Error('boom')
    const { result } = renderHook(() => useAsync(async () => Promise.reject(failure)))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current).toMatchObject({ status: 'error', error: failure })
  })

  it('reload() keeps the previous data on screen (refreshing) until the new data arrives', async () => {
    let next = deferred<string>()
    const load = vi.fn(() => next.promise)
    const { result } = renderHook(() => useAsync(load))
    next.resolve('first')
    await waitFor(() => expect(result.current).toMatchObject({ status: 'success', data: 'first' }))

    next = deferred<string>()
    act(() => result.current.reload())
    expect(result.current).toMatchObject({ status: 'success', data: 'first', refreshing: true }) // no flash back to loading
    next.resolve('second')
    await waitFor(() => expect(result.current).toMatchObject({ data: 'second', refreshing: false }))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a reload after an error shows loading again, then the result', async () => {
    let attempt = 0
    const { result } = renderHook(() => useAsync(async () => (++attempt === 1 ? Promise.reject(new Error('x')) : 'ok')))
    await waitFor(() => expect(result.current.status).toBe('error'))
    act(() => result.current.reload())
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current).toMatchObject({ status: 'success', data: 'ok' }))
  })

  it('a different key is a different resource: it shows loading, not the old resource', async () => {
    const { result, rerender } = renderHook(({ id }) => useAsync(async () => `item ${id}`, id), { initialProps: { id: 'a' } })
    await waitFor(() => expect(result.current).toMatchObject({ data: 'item a' }))
    rerender({ id: 'b' })
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current).toMatchObject({ data: 'item b' }))
  })

  it('aborts the request when the component goes away and ignores its late answer', async () => {
    const pending = deferred<string>()
    let signal: AbortSignal | undefined
    const { unmount } = renderHook(() => useAsync((s) => ((signal = s), pending.promise)))
    unmount()
    expect(signal?.aborted).toBe(true)
    pending.resolve('too late') // must not throw or update anything
    await pending.promise
  })
})
