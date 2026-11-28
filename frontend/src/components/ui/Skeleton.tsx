import type { ReactNode } from 'react'
import { cx } from '../../lib/cx'

/** A pulsing placeholder block. Decorative: wrap groups in <LoadingRegion> so screen readers hear "Loading". */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('animate-pulse rounded-xl bg-subtle motion-reduce:animate-none', className)} />
}

export function LoadingRegion({ label = 'Loading', children }: { label?: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  )
}

/** Placeholder rows shaped like a list of cards. */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-4 shadow-soft">
          <Skeleton className="h-10 w-16" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-7 w-24 rounded-full" />
        </div>
      ))}
    </div>
  )
}
