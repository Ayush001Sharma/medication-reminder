import { useEffect, type RefObject } from 'react'

/**
 * When a form reports errors, move keyboard focus to the first field marked invalid (aria-invalid="true"), so
 * people using a keyboard or screen reader land where the problem is instead of hunting for it.
 * `errors` is whatever the form keeps its errors in (a string, or an object keyed by field); empty means none.
 */
export function useFocusFirstInvalid(form: RefObject<HTMLElement | null>, errors: string | object | undefined): void {
  const hasErrors = typeof errors === 'string' ? errors !== '' : errors !== undefined && Object.keys(errors).length > 0
  useEffect(() => {
    if (hasErrors) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [errors, hasErrors, form])
}
