import { lazy, Suspense } from 'react'
import { api } from '../../api/client'
import type { AdherenceReport, Dose } from '../../api/types'
import { useAuth } from '../../auth/context'
import { NavIcon } from '../../components/layout/icons'
import { DoseStatusBadge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card, CardTitle } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Hint } from '../../components/ui/Hint'
import { PageHeader } from '../../components/ui/PageHeader'
import { LoadingRegion, Skeleton, SkeletonList } from '../../components/ui/Skeleton'
import { useAsync } from '../../hooks/useAsync'
import { firstName, localTime } from '../../lib/format'

// Recharts is large; load it only when this page actually shows the chart.
const AdherenceRing = lazy(() =>
  import('../../components/charts/AdherenceRing').then((module) => ({ default: module.AdherenceRing })),
)

function DoseList({ doses }: { doses: Dose[] }) {
  return (
    <ul className="space-y-3">
      {doses.map((dose) => (
        <li key={dose.id}>
          <Card className="flex items-center gap-4 !p-4">
            <span className="w-16 font-display text-2xl font-semibold text-ink">{localTime(dose.scheduled_local)}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-ink">{dose.medication.name}</p>
              <Hint className="truncate">{dose.medication.dosage}</Hint>
            </div>
            <DoseStatusBadge status={dose.status} late={dose.taken_late} />
          </Card>
        </li>
      ))}
    </ul>
  )
}

function AdherenceCard() {
  const report = useAsync((signal) => api.get<AdherenceReport>('/api/reports/adherence/', { signal }))
  return (
    // md:mt-11 lines the card up with the first dose card (the left column has a heading above its cards).
    <Card as="section" aria-labelledby="adherence-title" className="md:mt-11">
      <CardTitle id="adherence-title" className="mb-4">
        Last 30 days
      </CardTitle>
      {report.status === 'loading' && (
        <LoadingRegion label="Loading your adherence">
          <div className="flex flex-col items-center gap-4">
            <Skeleton className="h-40 w-40 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </div>
        </LoadingRegion>
      )}
      {report.status === 'error' && (
        <div>
          <p className="mb-3 text-base text-ink">We could not load your adherence.</p>
          <Button variant="secondary" size="md" onClick={report.reload}>
            Try again
          </Button>
        </div>
      )}
      {report.status === 'success' && (
        <div className="flex flex-col items-center gap-4 text-center">
          <Suspense fallback={<Skeleton className="h-40 w-40 rounded-full" />}>
            <AdherenceRing percent={report.data.totals.adherence_percent} />
          </Suspense>
          <Hint>
            {report.data.totals.taken} taken · {report.data.totals.missed} missed · {report.data.totals.skipped} skipped
          </Hint>
          <Hint>Current streak: {report.data.current_streak} doses in a row</Hint>
        </div>
      )}
    </Card>
  )
}

export function TodayPage() {
  const { user } = useAuth()
  const doses = useAsync((signal) => api.get<Dose[]>('/api/doses/today/', { signal }))

  return (
    <>
      <PageHeader
        title={user ? `Hello, ${firstName(user.full_name, user.email)}` : 'Today'}
        description="Here is what is scheduled for today, in your local time."
      />
      <div className="grid gap-6 md:grid-cols-3">
        <section aria-labelledby="doses-title" className="md:col-span-2">
          <h2 id="doses-title" className="mb-4 font-display text-xl font-semibold text-ink">
            Today&apos;s doses
          </h2>
          {doses.status === 'loading' && (
            <LoadingRegion label="Loading today's doses">
              <SkeletonList rows={3} />
            </LoadingRegion>
          )}
          {doses.status === 'error' && (
            <Card>
              <p className="mb-4 text-base text-ink">We could not load today&apos;s doses.</p>
              <Button variant="secondary" onClick={doses.reload}>
                Try again
              </Button>
            </Card>
          )}
          {doses.status === 'success' && doses.data.length === 0 && (
            <EmptyState
              icon={<NavIcon name="today" className="h-7 w-7" />}
              title="No doses today"
              description="When a medication is scheduled for today it will appear here."
            />
          )}
          {doses.status === 'success' && doses.data.length > 0 && <DoseList doses={doses.data} />}
        </section>
        <AdherenceCard />
      </div>
    </>
  )
}
