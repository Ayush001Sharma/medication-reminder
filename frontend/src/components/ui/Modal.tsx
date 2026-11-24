import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Buttons for the bottom of the dialog. */
  footer?: ReactNode
}

/**
 * An accessible dialog: focus moves in, Tab stays inside, Escape or a click outside closes it, the page
 * behind does not scroll, and focus returns to whatever opened it.
 */
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) {
        event.preventDefault()
        return
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      opener?.focus()
    }
  }, [open])

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-ink/40 p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-lg animate-rise rounded-2xl bg-surface p-6 shadow-lift focus:outline-none"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={titleId} className="font-display text-2xl font-semibold text-ink">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-2 flex h-11 w-11 items-center justify-center rounded-full text-ink transition duration-150 hover:bg-subtle"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="text-base text-ink">{children}</div>
        {footer && <div className="mt-6 flex flex-wrap justify-end gap-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
