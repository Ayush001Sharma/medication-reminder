import { api } from '../../api/client'
import type { AccessiblePatient } from '../../api/types'
import { InvitationsPanel } from '../../components/access/InvitationsPanel'
import { NavIcon } from '../../components/layout/icons'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Hint } from '../../components/ui/Hint'
import { PageHeader } from '../../components/ui/PageHeader'
import { LoadingRegion, SkeletonList } from '../../components/ui/Skeleton'
import { useAsync } from '../../hooks/useAsync'
import { displayName } from '../../lib/report'

/** Caregiver / doctor home: pending invitations to accept, then the patients who have granted access. */
export function PatientsPage() {
  const patients = useAsync((signal) => api.get<AccessiblePatient[]>('/api/patients/', { signal }))
  return (
    <>
      <PageHeader title="Patients" description="People who have shared their adherence with you. Access can be withdrawn by the patient at any time." />
      <div className="space-y-10">
        <InvitationsPanel onAccepted={patients.reload} />
        <section aria-labelledby="patients-title">
          <h2 id="patients-title" className="mb-4 font-display text-xl font-semibold text-ink">
            Your patients
          </h2>
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
                  <Card className="flex h-full flex-col">
                    <p className="truncate font-display text-xl font-semibold text-ink">{displayName(patient)}</p>
                    <Hint className="mt-1 truncate">{patient.email}</Hint>
                    <div className="mt-4">
                      <Badge tone="neutral">{patient.timezone.replaceAll('_', ' ')}</Badge>
                    </div>
                    <div className="mt-5">
                      <ButtonLink variant="secondary" size="md" to={`/patients/${patient.id}`} aria-label={`View adherence report for ${displayName(patient)}`}>
                        View report
                      </ButtonLink>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
