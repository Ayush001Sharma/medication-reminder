import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cx } from '../lib/cx'
import { ToastContext, type ToastApi, type ToastOptions, type ToastTone } from './context'

interface ToastItem {
  id: number
  tone: ToastTone
  message: string
  durationMs: number
  action?: ToastOptions['action']
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
  // The clock stops while the pointer is over the toast or focus is inside it, so it never vanishes while being read
  // or while its button is about to be pressed (WCAG 2.2.1 "timing adjustable").
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const timer = window.setTimeout(() => onDismiss(item.id), item.durationMs)
    return () => window.clearTimeout(timer)
  }, [item.id, item.durationMs, onDismiss, paused])

  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cx(
        'pointer-events-auto flex w-full max-w-md animate-rise items-start gap-3 rounded-2xl border p-4 shadow-lift',
        toneClasses[item.tone],
      )}
    >
      <p className="flex-1 text-base font-medium">{item.message}</p>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            onDismiss(item.id)
            item.action?.onClick()
          }}
          className="-my-1 min-h-11 shrink-0 rounded-xl px-3 text-base font-semibold underline underline-offset-4 transition duration-150 hover:bg-subtle"
        >
          {item.action.label}
        </button>
      )}
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
    setItems((current) => [
      ...current.slice(-3),
      // A toast with a button gets longer to read and act on.
      { id, tone, message, action: options?.action, durationMs: options?.durationMs ?? (options?.action ? 10000 : 6000) },
    ])
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message, options) => show('success', message, options),
      error: (message, options) => show('error', message, { durationMs: 9000, ...options }),
      info: (message, options) => show('info', message, options),
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
