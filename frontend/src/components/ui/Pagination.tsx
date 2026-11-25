import { Button } from './Button'

/** Previous / Next with a plain-language position ("Showing 21–40 of 87"). Pages are numbered from 1. */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  busy = false,
}: {
  page: number
  pageSize: number
  total: number
  onPage: (page: number) => void
  busy?: boolean
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)
  return (
    <nav aria-label="Pagination" className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <p className="text-base text-ink" aria-live="polite">
        Showing {first}–{last} of {total}
      </p>
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="md" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="text-sm font-semibold text-ink">
          Page {page} of {pageCount}
        </span>
        <Button variant="secondary" size="md" disabled={busy || page >= pageCount} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  )
}
