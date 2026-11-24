import { Link } from 'react-router-dom'

export function Logo() {
  return (
    <Link to="/" className="-mx-2 flex items-center gap-2 rounded-xl px-2 py-1">
      <svg className="h-7 w-7 text-sage-dark" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <path d="M14 3C8.5 8 6 12.5 6 16.5a8 8 0 0 0 16 0C22 12.5 19.5 8 14 3z" fill="currentColor" />
        <path d="M14 11v9M10 15.5h8" stroke="var(--color-sage-tint)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="font-display text-2xl font-semibold tracking-tight text-sage-dark">MedReminder</span>
    </Link>
  )
}
