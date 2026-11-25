import { lazy, Suspense } from 'react'
import { api } from '../../api/client'
import type { AdherenceReport } from '../../api/types'
import { useAsync } from '../../hooks/useAsync'
import { Button } from '../ui/Button'
import { Card, CardTitle } from '../ui/Card'
import { Hint } from '../ui/Hint'
import { LoadingRegion, Skeleton } from '../ui/Skeleton'

// Recharts is large; load it only when this card actually shows the chart.
const AdherenceRing = lazy(() => import('../charts/AdherenceRing').then((module) => ({ default: module.AdherenceRing })))

/** The last 30 days at a glance. Fails on its own without taking the rest of the page down. */
export function AdherenceCard() {
  const report = useAsync((signal) => api.get<AdherenceReport>('/api/reports/adherence/', { signal }))
  return (
    // md:mt-11 lines the card up with the first dose card (the list beside it has a heading above its cards).
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
