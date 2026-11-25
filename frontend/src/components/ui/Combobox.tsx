import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react'
import { cx } from '../../lib/cx'

export interface ComboboxOption {
  value: string
  label: string
  /** Secondary text shown at the end of the row and searched too (for example a UTC offset). */
  detail?: string
  /** Extra words that find this option without being shown (for example a former name). */
  keywords?: string
}

interface ComboboxProps {
  label: string
  options: ComboboxOption[]
  value: string
  onChange: (value: string) => void
  hint?: string
  error?: string
  placeholder?: string
  emptyText?: string
}

/** Lower-case, and treat "_" and "/" as spaces so "new york" finds "America/New_York". */
const normalize = (text: string) => text.toLowerCase().replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * A searchable select (the ARIA "editable combobox with list autocomplete" pattern). Type to filter, Arrow keys
 * to move, Enter to choose, Escape to close. Only values from `options` can be chosen: leaving the field with
 * half-typed text restores the current choice instead of inventing a value.
 *
 * It renders on a white surface, so the muted detail text is allowed here.
 */
export function Combobox({ label, options, value, onChange, hint, error, placeholder, emptyText = 'No matches' }: ComboboxProps) {
  const base = useId()
  const inputId = `${base}-input`
  const listId = `${base}-list`
  const hintId = `${base}-hint`
  const errorId = `${base}-error`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<string | null>(null) // null: show the current choice
  const [active, setActive] = useState(0)

  const selected = options.find((option) => option.value === value)
  const filtered = useMemo(() => {
    const needle = normalize(query ?? '')
    if (!needle) return options
    return options.filter((option) => normalize(`${option.label} ${option.detail ?? ''} ${option.keywords ?? ''}`).includes(needle))
  }, [options, query])

  const activeIndex = Math.min(active, Math.max(filtered.length - 1, 0))
  const activeId = open && filtered[activeIndex] ? `${listId}-${activeIndex}` : undefined

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])

  function choose(option: ComboboxOption) {
    onChange(option.value)
    setQuery(null)
    setOpen(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) setOpen(true)
      else setActive(Math.min(activeIndex + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(activeIndex - 1, 0))
    } else if (event.key === 'Enter' && open) {
      event.preventDefault() // choosing must not submit the form
      const option = filtered[activeIndex]
      if (option) choose(option)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation() // closes the list, not a dialog around it
      setOpen(false)
      setQuery(null)
    }
  }

  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className="relative">
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-semibold text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={placeholder}
          value={query ?? selected?.label ?? ''}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={(event) => event.target.select()}
          onClick={() => setOpen(true)}
          onBlur={() => {
            setOpen(false)
            setQuery(null)
          }}
          onKeyDown={onKeyDown}
          className={cx(
            'block min-h-12 w-full rounded-2xl border bg-surface py-0 pl-4 pr-11 text-base text-ink placeholder:text-muted',
            'transition duration-150 hover:border-sage-dark',
            error ? 'border-danger' : 'border-sage',
          )}
        />
        <svg className="pointer-events-none absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-sage-dark" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {open && (
        <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-line bg-surface shadow-lift">
          <ul id={listId} role="listbox" aria-label={label} hidden={filtered.length === 0} className="max-h-64 overflow-y-auto p-1">
            {filtered.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                // mousedown (not click) so the input keeps focus and its blur does not close the list first
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(option)
                }}
                onMouseMove={() => setActive(index)}
                className={cx(
                  'flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 text-base text-ink',
                  index === activeIndex && 'bg-sage-tint',
                  option.value === value && 'font-semibold',
                )}
              >
                <span className="truncate">{option.label}</span>
                {option.detail && <span className="shrink-0 text-sm text-muted">{option.detail}</span>}
              </li>
            ))}
          </ul>
          {filtered.length === 0 && (
            <div role="status" className="px-4 py-3 text-base text-muted">
              {emptyText}
            </div>
          )}
        </div>
      )}

      {hint && (
        <p id={hintId} className="mt-1.5 text-sm text-ink">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
