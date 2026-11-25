import { createContext, useContext } from 'react'

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastOptions {
  durationMs?: number
  /** A button inside the toast, for example "Try again". Clicking it dismisses the toast, then runs onClick. */
  action?: { label: string; onClick: () => void }
}

export interface ToastApi {
  show(tone: ToastTone, message: string, options?: ToastOptions): void
  success(message: string, options?: ToastOptions): void
  error(message: string, options?: ToastOptions): void
  info(message: string, options?: ToastOptions): void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside <ToastProvider>')
  return value
}
