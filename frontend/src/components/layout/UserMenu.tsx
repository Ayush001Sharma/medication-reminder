import { useEffect, useId, useRef, useState } from 'react'
import { ROLE_LABEL, useAuth } from '../../auth/context'
import { Badge } from '../ui/Badge'

function initialsOf(name: string, email: string): string {
  const source = name.trim() || email
  return (source[0] ?? '?').toUpperCase()
}

/** Avatar button that opens a small menu with who you are and "Sign out". */
export function UserMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    firstItemRef.current?.focus()
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!user) return null
  const displayName = user.full_name.trim() || user.email

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Account menu for ${displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 items-center gap-3 rounded-full py-1 pl-1 pr-2 transition duration-150 hover:bg-subtle md:pr-4"
      >
        <span
          aria-hidden="true"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-sage-tint font-semibold text-sage-dark"
        >
          {initialsOf(user.full_name, user.email)}
        </span>
        <span className="hidden max-w-40 truncate text-sm font-semibold text-ink md:block">{displayName}</span>
        <svg className="hidden h-4 w-4 text-sage-dark md:block" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-40 mt-2 w-72 animate-fade-in rounded-2xl border border-line bg-surface p-2 shadow-lift"
        >
          <div className="px-3 py-3">
            <p className="truncate font-semibold text-ink">{displayName}</p>
            <p className="truncate text-sm text-muted">{user.email}</p>
            <div className="mt-2">
              <Badge tone="success">{ROLE_LABEL[user.role]}</Badge>
            </div>
          </div>
          <div className="border-t border-line pt-2">
            <button
              ref={firstItemRef}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                logout()
              }}
              className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left font-semibold text-ink transition duration-150 hover:bg-subtle"
            >
              <svg className="h-5 w-5 text-sage-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 8l4 4-4 4M20 12H9" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
