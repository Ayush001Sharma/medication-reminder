import type { ReactNode } from 'react'

/** "Nothing here yet" with a way forward. White surface, so muted text is allowed. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  headingAs: Heading = 'h2',
}: {
  title: string
  description?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  /** Use 'h1' when the empty state is the whole page (for example a 403 or 404). */
  headingAs?: 'h1' | 'h2' | 'h3'
}) {
  return (
    <div className="rounded-2xl border border-dashed border-sage bg-surface px-6 py-12 text-center">
      {icon && (
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-sage-tint text-sage-dark">
          {icon}
        </div>
      )}
      <Heading className="font-display text-xl font-semibold text-ink">{title}</Heading>
      {description && <p className="mx-auto mt-2 max-w-md text-base text-muted">{description}</p>}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  )
}
