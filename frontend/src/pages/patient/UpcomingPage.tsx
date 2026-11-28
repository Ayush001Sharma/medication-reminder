import { api } from '../../api/client'
import type { Dose } from '../../api/types'
import { useAuth } from '../../auth/context'
import { DoseCard } from '../../components/doses/DoseCard'
import { NavIcon } from '../../components/layout/icons'
import { Button } from '../../components/ui/Button'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { LoadingRegion, SkeletonList } from '../../components/ui/Skeleton'
import { useAsync } from '../../hooks/useAsync'
import { dayHeading, todayInZone, zoneOf } from '../../lib/dates'
import { groupByDay } from '../../lib/doses'
import { usePageTitle } from '../../hooks/usePageTitle'

const DAYS = 7

export function UpcomingPage() {
  usePageTitle('Upcoming')
  const { user } = useAuth()
  const timeZone = zoneOf(user?.patient_profile)
  const doses = useAsync((signal) => api.get<Dose[]>('/api/doses/upcoming/', { signal, query: { days: DAYS } }))
  const today = todayInZone(timeZone)

  return (
    <>
      <PageHeader title="Upcoming" description={`Everything scheduled over the next ${DAYS} days, in your local time.`} />

      {doses.status === 'loading' && (
        <LoadingRegion label="Loading upcoming doses">
          <SkeletonList rows={4} />
        </LoadingRegion>
      )}

      {doses.status === 'error' && (
        <Card>
          <p className="mb-4 text-base text-ink">We could not load your upcoming doses.</p>
          <Button variant="secondary" onClick={doses.reload}>
            Try again
          </Button>
        </Card>
      )}

      {doses.status === 'success' && doses.data.length === 0 && (
        <EmptyState
          icon={<NavIcon name="upcoming" className="h-7 w-7" />}
          title={`Nothing coming up in the next ${DAYS} days`}
          description="Add a medication with a schedule and its doses will show up here."
          action={<ButtonLink to="/medications/new">Add a medication</ButtonLink>}
        />
      )}

      {doses.status === 'success' && doses.data.length > 0 && (
        <div className="space-y-8">
          {groupByDay(doses.data).map(({ date, doses: group }) => (
            <section key={date} aria-labelledby={`day-${date}`}>
              <h2 id={`day-${date}`} className="mb-3 font-display text-xl font-semibold text-ink">
                {dayHeading(date, today)}
              </h2>
              <ul className="space-y-3">
                {group.map((dose) => (
                  <li key={dose.id}>
                    <DoseCard dose={dose} timeZone={timeZone} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  )
}
