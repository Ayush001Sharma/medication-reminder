import { forwardRef, useId, type InputHTMLAttributes } from 'react'
import { cx } from '../../lib/cx'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: string
  error?: string
}

/*
 * The border is sage (3.6:1 on white), not the pale decorative line colour, so the field's edge meets the
 * 3:1 non-text contrast requirement. Hints use ink so they pass AA on any background.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const generated = useId()
  const inputId = id ?? generated
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined
  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-semibold text-ink">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          'block min-h-12 w-full rounded-2xl border bg-surface px-4 text-base text-ink placeholder:text-muted',
          'transition duration-150 hover:border-sage-dark disabled:opacity-60',
          error ? 'border-danger' : 'border-sage',
          className,
        )}
        {...rest}
      />
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
})
