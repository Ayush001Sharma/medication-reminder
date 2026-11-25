import { useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { Dose } from '../../api/types'
import { useAuth } from '../../auth/context'
import { AdherenceCard } from '../../components/doses/AdherenceCard'
import { DoseCard } from '../../components/doses/DoseCard'
import { NavIcon } from '../../components/layout/icons'
import { Button } from '../../components/ui/Button'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { LoadingRegion, SkeletonList } from '../../components/ui/Skeleton'
import { useAsync } from '../../hooks/useAsync'
import { longDate, todayInZone, zoneOf } from '../../lib/dates'
import { conflictMessage, countTaken, groupByDayPart, optimisticDose, type DoseAction } from '../../lib/doses'
import { useToast } from '../../toast/context'

/** Optimistic changes belong to one batch of server data; when fresh data arrives they are dropped. */
interface Overrides {
  forData: Dose[] | null
  byId: Record<number, Dose>
}

export function TodayPage() {
  const { user } = useAuth()
  const toast = useToast()
  const timeZone = zoneOf(user?.patient_profile)
  const doses = useAsync((signal) => api.get<Dose[]>('/api/doses/today/', { signal }))
  const [overrides, setOverrides] = useState<Overrides>({ forData: null, byId: {} })
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set())

  const serverDoses = doses.status === 'success' ? doses.data : null
  const activeOverrides = overrides.forData === serverDoses ? overrides.byId : {}
  const shown = serverDoses ? serverDoses.map((dose) => activeOverrides[dose.id] ?? dose) : []

  function setOverride(id: number, dose: Dose | null) {
    setOverrides((previous) => {
      const base = previous.forData === serverDoses ? previous.byId : {}
      const { [id]: _removed, ...rest } = base
      void _removed
      return { forData: serverDoses, byId: dose ? { ...rest, [id]: dose } : rest }
    })
  }

  function setBusyFor(id: number, working: boolean) {
    setBusy((previous) => {
      const next = new Set(previous)
      if (working) next.add(id)
      else next.delete(id)
      return next
    })
  }

  /** Show the result at once, ask the server, and keep or undo the change depending on the answer. */
  async function act(dose: Dose, action: DoseAction) {
    if (busy.has(dose.id)) return // a second click while the first is still travelling
    setBusyFor(dose.id, true)
    setOverride(dose.id, optimisticDose(dose, action))
    const name = dose.medication.name
    try {
      const updated = await api.post<Dose>(`/api/doses/${dose.id}/${action}/`)
      setOverride(dose.id, updated)
      toast.success(
        action === 'skip' ? `Skipped ${name}.` : updated.taken_late ? `Recorded ${name} as taken late.` : `Marked ${name} as taken.`,
      )
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // The dose changed elsewhere (another device, or the missed-dose job). Say so, and load the truth.
        toast.info(conflictMessage(error.message, action))
        doses.reload()
      } else {
        setOverride(dose.id, null) // undo the optimistic change
        const message = error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'
        toast.error(`${name} was not updated. ${message}`, { action: { label: 'Try again', onClick: () => void act(dose, action) } })
      }
    } finally {
      setBusyFor(dose.id, false)
    }
  }

  const progress = countTaken(shown)
  const today = todayInZone(timeZone)
  const description =
    doses.status === 'success' && progress.total > 0
      ? `${longDate(today)} · ${progress.taken} of ${progress.total} taken`
      : longDate(today)

  return (
    <>
      <PageHeader title="Today" description={description} />
      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
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

          {doses.status === 'success' && shown.length === 0 && (
            <EmptyState
              icon={<NavIcon name="today" className="h-7 w-7" />}
              title="Nothing scheduled today"
              description="A quiet day. When a medication is due, it will appear here."
              action={<ButtonLink to="/medications" variant="secondary">See my medications</ButtonLink>}
            />
          )}

          {doses.status === 'success' && shown.length > 0 && (
            <div className="space-y-8">
              {groupByDayPart(shown).map(({ part, doses: group }) => (
                <section key={part.id} aria-labelledby={`part-${part.id}`}>
                  <h2 id={`part-${part.id}`} className="mb-3 flex items-baseline gap-3 font-display text-xl font-semibold text-ink">
                    {part.label}
                    <span className="font-sans text-sm font-normal text-ink">{part.hours}</span>
                  </h2>
                  <ul className="space-y-3">
                    {group.map((dose) => (
                      <li key={dose.id}>
                        <DoseCard dose={dose} timeZone={timeZone} busy={busy.has(dose.id)} onAction={act} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
        <AdherenceCard />
      </div>
    </>
  )
}
