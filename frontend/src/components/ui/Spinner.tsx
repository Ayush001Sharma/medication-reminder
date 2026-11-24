import { cx } from '../../lib/cx'

/** Decorative: pair it with visible or screen-reader text that says what is loading. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('h-5 w-5 animate-spin motion-reduce:animate-none', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
