import { InvitationsPanel } from '../../components/access/InvitationsPanel'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { PageHeader } from '../../components/ui/PageHeader'
import { usePageTitle } from '../../hooks/usePageTitle'

export function InvitationsPage() {
  usePageTitle('Invitations')
  return (
    <>
      <PageHeader
        title="Invitations"
        description="Patients who want to share their reports with you. Accepting gives you access to their adherence report."
        actions={<ButtonLink variant="secondary" to="/patients">See your patients</ButtonLink>}
      />
      <InvitationsPanel showHeading={false} />
    </>
  )
}
