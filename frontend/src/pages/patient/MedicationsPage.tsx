import { useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { Medication, MedicationWithSchedules, Schedule } from '../../api/types'
import { MedicationCard } from '../../components/medications/MedicationCard'
import { NavIcon } from '../../components/layout/icons'
import { Button } from '../../components/ui/Button'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Modal } from '../../components/ui/Modal'
import { PageHeader } from '../../components/ui/PageHeader'
import { LoadingRegion, SkeletonList } from '../../components/ui/Skeleton'
import { useAsync } from '../../hooks/useAsync'
import { activeFirst } from '../../lib/medications'
import { useToast } from '../../toast/context'

/** Medications with their schedules (the API has no combined endpoint, so the schedules are fetched in parallel). */
async function loadMedications(signal: AbortSignal): Promise<MedicationWithSchedules[]> {
  const medications = await api.get<Medication[]>('/api/medications/', { signal })
  const schedules = await Promise.all(medications.map((m) => api.get<Schedule[]>(`/api/medications/${m.id}/schedules/`, { signal })))
  return medications.map((medication, index) => ({ ...medication, schedules: schedules[index] ?? [] }))
}

export function MedicationsPage() {
  const toast = useToast()
  const medications = useAsync(loadMedications)
  const [stopped, setStopped] = useState<ReadonlySet<number>>(new Set())
  const [target, setTarget] = useState<MedicationWithSchedules | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)

  const list = medications.status === 'success' ? medications.data.map((m) => (stopped.has(m.id) ? { ...m, is_active: false } : m)) : []
  const { active, stopped: stoppedList } = activeFirst(list)

  function close() {
    if (stopping) return // do not abandon a request that is on its way
    setTarget(null)
    setStopError(null)
  }

  async function confirmStop() {
    if (!target) return
    setStopping(true)
    setStopError(null)
    try {
      await api.post(`/api/medications/${target.id}/deactivate/`)
      setStopped((previous) => new Set(previous).add(target.id))
      toast.success(`${target.name} stopped. Its upcoming reminders have been removed.`)
      setTarget(null)
    } catch (error) {
      setStopError(error instanceof ApiError ? error.message : 'Something went wrong. Please try again.')
    } finally {
      setStopping(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Medications"
        description="Your prescriptions and when to take them."
        actions={<ButtonLink to="/medications/new">Add medication</ButtonLink>}
      />

      {medications.status === 'loading' && (
        <LoadingRegion label="Loading your medications">
          <SkeletonList rows={3} />
        </LoadingRegion>
      )}

      {medications.status === 'error' && (
        <Card>
          <p className="mb-4 text-base text-ink">We could not load your medications.</p>
          <Button variant="secondary" onClick={medications.reload}>
            Try again
          </Button>
        </Card>
      )}

      {medications.status === 'success' && list.length === 0 && (
        <EmptyState
          icon={<NavIcon name="medications" className="h-7 w-7" />}
          title="No medications yet"
          description="Add a prescription and when you take it, and we will remind you at the right time."
          action={<ButtonLink to="/medications/new">Add your first medication</ButtonLink>}
        />
      )}

      {medications.status === 'success' && list.length > 0 && (
        <div className="space-y-10">
          {active.length > 0 && (
            <section aria-labelledby="active-title">
              <h2 id="active-title" className="sr-only">
                Current medications
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {active.map((medication) => (
                  <MedicationCard key={medication.id} medication={medication} onStop={setTarget} />
                ))}
              </div>
            </section>
          )}
          {stoppedList.length > 0 && (
            <section aria-labelledby="stopped-title">
              <h2 id="stopped-title" className="mb-4 font-display text-xl font-semibold text-ink">
                Stopped
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {stoppedList.map((medication) => (
                  <MedicationCard key={medication.id} medication={medication} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <Modal
        open={target !== null}
        onClose={close}
        title={target ? `Stop ${target.name}?` : 'Stop medication'}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={stopping}>
              Keep it
            </Button>
            <Button variant="danger" loading={stopping} onClick={confirmStop}>
              Stop medication
            </Button>
          </>
        }
      >
        <p>
          Reminders stop and its upcoming doses are removed. Your dose history is kept. This can&apos;t be undone from here, but you can add the
          medication again as a new one.
        </p>
        {stopError && (
          <p role="alert" className="mt-4 rounded-2xl border border-danger p-3 font-medium text-danger">
            {stopError}
          </p>
        )}
      </Modal>
    </>
  )
}
