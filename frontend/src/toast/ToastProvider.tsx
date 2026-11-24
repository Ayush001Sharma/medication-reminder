import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cx } from '../lib/cx'
import { ToastContext, type ToastApi, type ToastTone } from './context'

interface ToastItem {
  id: number
  tone: ToastTone
  message: string
  durationMs: number
}

/*
 * Text/fill pairs: sage-dark on sage-tint 5.0, danger on white 5.3, ink on white 13.6. Errors use role="alert"
 * (announced immediately); the rest use role="status" (announced politely).
 */
const toneClasses: Record<ToastTone, string> = {
  success: 'border-sage bg-sage-tint text-sage-dark',
  error: 'border-danger bg-surface text-danger',
  info: 'border-line bg-surface text-ink',
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.id), item.durationMs)
    return () => window.clearTimeout(timer)
  }, [item.id, item.durationMs, onDismiss])

  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'pointer-events-auto flex w-full max-w-md animate-rise items-start gap-3 rounded-2xl border p-4 shadow-lift',
        toneClasses[item.tone],
      )}
    >
      <p className="flex-1 text-base font-medium">{item.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition duration-150 hover:bg-subtle"
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), [])

  const show = useCallback<ToastApi['show']>((tone, message, options) => {
    const id = nextId.current++
    setItems((current) => [...current.slice(-3), { id, tone, message, durationMs: options?.durationMs ?? 6000 }])
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message) => show('success', message),
      error: (message) => show('error', message, { durationMs: 9000 }),
      info: (message) => show('info', message),
    }),
    [show],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Above the mobile bottom navigation, bottom-centred on larger screens. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-3 px-4 md:bottom-6">
        {items.map((item) => (
          <Toast key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}
