import { useParams } from 'react-router-dom'
import { api, ApiError } from '../../api/client'
import type { Medication, Schedule } from '../../api/types'
import { useAuth } from '../../auth/context'
import { MedicationForm } from '../../components/medications/MedicationForm'
import { Button } from '../../components/ui/Button'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { LoadingRegion, Skeleton } from '../../components/ui/Skeleton'
import { useAsync } from '../../hooks/useAsync'
import { todayInZone, zoneOf } from '../../lib/dates'

export function NewMedicationPage() {
  const { user } = useAuth()
  const timeZone = zoneOf(user?.patient_profile)
  return (
    <>
      <PageHeader title="Add medication" description="Tell us what you take and when. We will remind you at those times." />
      <div className="max-w-2xl">
        <MedicationForm mode="create" timeZone={timeZone} today={todayInZone(timeZone)} />
      </div>
    </>
  )
}

export function EditMedicationPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const timeZone = zoneOf(user?.patient_profile)
  const loaded = useAsync(async (signal) => {
    const [medication, schedules] = await Promise.all([
      api.get<Medication>(`/api/medications/${id}/`, { signal }),
      api.get<Schedule[]>(`/api/medications/${id}/schedules/`, { signal }),
    ])
    return { medication, schedules }
  }, id)

  return (
    <>
      <PageHeader title="Edit medication" />
      <div className="max-w-2xl">
        {loaded.status === 'loading' && (
          <LoadingRegion label="Loading the medication">
            <Card className="space-y-5">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-24" />
            </Card>
          </LoadingRegion>
        )}

        {loaded.status === 'error' &&
          (loaded.error instanceof ApiError && loaded.error.status === 404 ? (
            <EmptyState
              headingAs="h2"
              title="We could not find that medication"
              description="It may have been removed, or the link may be out of date."
              action={<ButtonLink to="/medications">Back to medications</ButtonLink>}
            />
          ) : (
            <Card>
              <p className="mb-4 text-base text-ink">We could not load this medication.</p>
              <Button variant="secondary" onClick={loaded.reload}>
                Try again
              </Button>
            </Card>
          ))}

        {loaded.status === 'success' && !loaded.data.medication.is_active && (
          <EmptyState
            title="This medication has been stopped"
            description="Stopped medications cannot be edited. You can add it again as a new medication."
            action={<ButtonLink to="/medications/new">Add a medication</ButtonLink>}
          />
        )}

        {loaded.status === 'success' && loaded.data.medication.is_active && (
          <MedicationForm
            key={id}
            mode="edit"
            timeZone={timeZone}
            today={todayInZone(timeZone)}
            medication={loaded.data.medication}
            schedule={loaded.data.schedules[0]}
            otherSchedules={Math.max(loaded.data.schedules.length - 1, 0)}
          />
        )}
      </div>
    </>
  )
}
