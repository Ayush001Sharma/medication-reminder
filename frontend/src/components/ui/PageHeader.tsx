import type { ReactNode } from 'react'

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-3xl font-semibold text-ink md:text-4xl">{title}</h1>
        {description && <p className="mt-2 max-w-prose text-base text-ink">{description}</p>}
      </div>
      {actions}
    </div>
  )
}
