import { api } from '../../api/client'
import type { AccessiblePatient } from '../../api/types'
import { NavIcon } from '../../components/layout/icons'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Hint } from '../../components/ui/Hint'
import { PageHeader } from '../../components/ui/PageHeader'
import { LoadingRegion, SkeletonList } from '../../components/ui/Skeleton'
import { useAsync } from '../../hooks/useAsync'

export function PatientsPage() {
  const patients = useAsync((signal) => api.get<AccessiblePatient[]>('/api/patients/', { signal }))
  return (
    <>
      <PageHeader title="Patients" description="People who have shared their adherence with you. Access can be withdrawn by the patient at any time." />
      {patients.status === 'loading' && (
        <LoadingRegion label="Loading patients">
          <SkeletonList rows={3} />
        </LoadingRegion>
      )}
      {patients.status === 'error' && (
        <Card>
          <p className="mb-4 text-base text-ink">We could not load your patients.</p>
          <Button variant="secondary" onClick={patients.reload}>
            Try again
          </Button>
        </Card>
      )}
      {patients.status === 'success' && patients.data.length === 0 && (
        <EmptyState
          icon={<NavIcon name="patients" className="h-7 w-7" />}
          title="No patients yet"
          description="When a patient invites you and you accept, they will appear here."
        />
      )}
      {patients.status === 'success' && patients.data.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2">
          {patients.data.map((patient) => (
            <li key={patient.id}>
              <Card className="h-full">
                <p className="truncate font-display text-xl font-semibold text-ink">{patient.full_name || patient.email}</p>
                <Hint className="mt-1 truncate">{patient.email}</Hint>
                <div className="mt-4">
                  <Badge tone="neutral">{patient.timezone.replaceAll('_', ' ')}</Badge>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
