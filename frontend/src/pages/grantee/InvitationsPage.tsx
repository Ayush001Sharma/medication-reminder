import { InvitationsPanel } from '../../components/access/InvitationsPanel'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { PageHeader } from '../../components/ui/PageHeader'

export function InvitationsPage() {
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
