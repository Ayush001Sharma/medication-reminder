import { useSearchParams } from 'react-router-dom'
import { api } from '../../api/client'
import type { AuditEntry, Page } from '../../api/types'
import { useAuth } from '../../auth/context'
import { NavIcon } from '../../components/layout/icons'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Hint } from '../../components/ui/Hint'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { LoadingRegion, SkeletonList } from '../../components/ui/Skeleton'
import { useAsync } from '../../hooks/useAsync'
import { formatInstant, shortDate, zoneOf } from '../../lib/dates'
import { roleLabel } from '../../lib/report'

export const ACTIVITY_PAGE_SIZE = 20

/** Who looked at the patient's data, newest first, 20 to a page. The page number lives in the address (?page=2). */
export function ActivityPage() {
  const zone = zoneOf(useAuth().user?.patient_profile)
  const [params, setParams] = useSearchParams()
  const requested = Number.parseInt(params.get('page') ?? '1', 10)
  const page = Number.isFinite(requested) && requested > 0 ? requested : 1

  const log = useAsync(
    (signal) =>
      api.get<Page<AuditEntry>>('/api/audit-log/', { signal, query: { limit: ACTIVITY_PAGE_SIZE, offset: (page - 1) * ACTIVITY_PAGE_SIZE } }),
    String(page),
  )
  const goTo = (next: number) => setParams(next <= 1 ? {} : { page: String(next) })

  return (
    <>
      <PageHeader
        title="Activity"
        description="Every time a caregiver or doctor looked at your adherence report, or was sent your weekly summary."
      />
      {log.status === 'loading' && (
        <LoadingRegion label="Loading your activity">
          <SkeletonList rows={4} />
        </LoadingRegion>
      )}
      {log.status === 'error' && (
        <Card>
          <p className="mb-4 text-base text-ink">We could not load your activity.</p>
          <Button variant="secondary" onClick={log.reload}>
            Try again
          </Button>
        </Card>
      )}
      {log.status === 'success' && log.data.count === 0 && (
        <EmptyState
          icon={<NavIcon name="activity" className="h-7 w-7" />}
          title="Nobody has looked yet"
          description="When someone you share with views your report, it will be listed here with the date and time."
        />
      )}
      {log.status === 'success' && log.data.count > 0 && log.data.results.length === 0 && (
        <EmptyState
          title="That page is empty"
          description="There are no entries this far back."
          action={<Button onClick={() => goTo(1)}>Back to the newest</Button>}
        />
      )}
      {log.status === 'success' && log.data.results.length > 0 && (
        <>
          <ol aria-label="Access log, newest first" className="space-y-3">
            {log.data.results.map((entry) => (
              <li key={entry.id}>
                <Card className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                  <div className="min-w-0">
                    <p className="break-words text-base text-ink">
                      <span className="font-semibold">{entry.viewer_email}</span>{' '}
                      {entry.action === 'report_view' ? 'viewed your report' : 'was emailed your weekly summary'}
                    </p>
                    <Hint className="mt-1">
                      Covering {shortDate(entry.range_start)} to {shortDate(entry.range_end)}
                    </Hint>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone="neutral">{roleLabel(entry.viewer_role)}</Badge>
                    <time dateTime={entry.created_at} className="text-sm font-semibold text-ink">
                      {formatInstant(entry.created_at, zone)}
                    </time>
                  </div>
                </Card>
              </li>
            ))}
          </ol>
          <Pagination page={page} pageSize={ACTIVITY_PAGE_SIZE} total={log.data.count} onPage={goTo} busy={log.refreshing} />
        </>
      )}
    </>
  )
}
