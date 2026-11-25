import { useId, useState, type ReactNode } from 'react'

/**
 * A small "i" button that explains something. The explanation shows on hover, on keyboard focus and when the
 * button is pressed (so it works on touch screens too); Escape closes it. The button is described by the
 * tooltip, so screen reader users hear the text without opening anything.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hovered || focused || pinned

  function close() {
    setHovered(false)
    setFocused(false)
    setPinned(false)
  }

  return (
    <span className="relative inline-flex" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setPinned((value) => !value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          setPinned(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
        className="flex h-11 w-11 items-center justify-center rounded-full text-sage-dark transition duration-150 hover:bg-sage-tint"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      </button>
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        className="absolute left-1/2 top-full z-20 mt-1 w-64 max-w-[80vw] -translate-x-1/2 rounded-2xl bg-ink p-3 text-left text-sm font-normal text-surface shadow-lift"
      >
        {children}
      </span>
    </span>
  )
}
