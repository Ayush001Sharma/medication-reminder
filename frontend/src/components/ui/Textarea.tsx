import { forwardRef, useId, type TextareaHTMLAttributes } from 'react'
import { cx } from '../../lib/cx'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string
  hint?: string
  error?: string
}

/** Same field chrome as Input: sage border (3:1), visible label, hint and error wired with aria-describedby. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, rows = 3, ...rest },
  ref,
) {
  const generated = useId()
  const fieldId = id ?? generated
  const hintId = `${fieldId}-hint`
  const errorId = `${fieldId}-error`
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined
  return (
    <div>
      <label htmlFor={fieldId} className="mb-1.5 block text-sm font-semibold text-ink">
        {label}
      </label>
      <textarea
        ref={ref}
        id={fieldId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          'block w-full rounded-2xl border bg-surface px-4 py-3 text-base text-ink placeholder:text-muted',
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
