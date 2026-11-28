import { useRef, useState, type FormEvent } from 'react'
import { api, ApiError } from '../../api/client'
import type { Grant } from '../../api/types'
import { useAuth } from '../../auth/context'
import { NavIcon } from '../../components/layout/icons'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Hint } from '../../components/ui/Hint'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import { PageHeader } from '../../components/ui/PageHeader'
import { LoadingRegion, SkeletonList } from '../../components/ui/Skeleton'
import { useAsync } from '../../hooks/useAsync'
import { useFocusFirstInvalid } from '../../hooks/useFocusFirstInvalid'
import { dateOfInstant, zoneOf } from '../../lib/dates'
import { displayName, roleLabel } from '../../lib/report'
import { useToast } from '../../toast/context'
import { usePageTitle } from '../../hooks/usePageTitle'

/** Shown if the API does not send its own text. The API answers every valid email with the same sentence. */
const NEUTRAL_CONFIRMATION =
  'Invitation recorded. Access starts only if that person accepts it from a caregiver or doctor account registered with this email.'

function isEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value)
}

/** Who may see the patient's reports: invite by email, see who has access, and revoke at any time. */
export function SharingPage() {
  usePageTitle('Sharing')
  const toast = useToast()
  const zone = zoneOf(useAuth().user?.patient_profile)
  const grants = useAsync((signal) => api.get<Grant[]>('/api/access/grants/', { signal }))

  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | undefined>()
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const inviteForm = useRef<HTMLFormElement>(null)
  useFocusFirstInvalid(inviteForm, emailError)

  const [target, setTarget] = useState<Grant | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [removed, setRemoved] = useState<ReadonlySet<number>>(new Set())

  async function invite(event: FormEvent) {
    event.preventDefault()
    if (sending) return
    const trimmed = email.trim()
    setConfirmation(null)
    setFormError(null)
    if (!trimmed) return setEmailError('Enter their email address.')
    if (!isEmail(trimmed)) return setEmailError('Enter a valid email address.')
    setEmailError(undefined)
    setSending(true)
    try {
      const response = await api.post<{ detail?: string }>('/api/access/grants/', { email: trimmed })
      // The same sentence whatever the address: it never says whether that person has an account.
      setConfirmation(response?.detail || NEUTRAL_CONFIRMATION)
      setEmail('')
      grants.reload()
    } catch (error) {
      if (error instanceof ApiError && error.fieldErrors.email) setEmailError(error.fieldErrors.email)
      else setFormError(error instanceof ApiError ? error.message : 'Something went wrong. Please try again.')
    } finally {
      setSending(false)
    }
  }

  function close() {
    if (revoking) return
    setTarget(null)
    setRevokeError(null)
  }

  async function confirmRevoke() {
    if (!target) return
    setRevoking(true)
    setRevokeError(null)
    const pending = target.status === 'pending'
    try {
      await api.post(`/api/access/grants/${target.id}/revoke/`)
      toast.success(pending ? 'Invitation cancelled.' : `${nameOf(target)} can no longer see your reports.`)
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        setRevokeError(error instanceof ApiError ? error.message : 'Something went wrong. Please try again.')
        setRevoking(false)
        return
      }
      toast.info('That entry was already gone, so there is nothing more to do.') // e.g. removed in another tab
    }
    setRemoved((previous) => new Set(previous).add(target.id))
    setTarget(null)
    setRevoking(false)
    grants.reload()
  }

  const visible = grants.status === 'success' ? grants.data.filter((g) => g.status !== 'revoked' && !removed.has(g.id)) : []
  const active = visible.filter((g) => g.status === 'active')
  const pending = visible.filter((g) => g.status === 'pending')

  return (
    <>
      <PageHeader
        title="Sharing"
        description="Invite a caregiver or doctor to see your adherence report. You choose who, and you can take access away at any time."
      />

      <Card as="section" aria-labelledby="invite-title" className="mb-10">
        <h2 id="invite-title" className="mb-4 font-display text-xl font-semibold text-ink">
          Invite someone
        </h2>
        <form ref={inviteForm} onSubmit={invite} noValidate className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-start">
          <Input
            label="Their email address"
            type="email"
            autoComplete="off"
            value={email}
            error={emailError}
            hint="They need a caregiver or doctor account with this email to accept."
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" loading={sending} className="sm:mt-7">
            Send invitation
          </Button>
        </form>
        {formError && (
          <p role="alert" className="mt-4 rounded-2xl border border-danger p-3 font-medium text-danger">
            {formError}
          </p>
        )}
        {confirmation && (
          <p role="status" className="mt-4 rounded-2xl bg-sage-tint p-3 text-base text-ink">
            {confirmation}
          </p>
        )}
      </Card>

      {grants.status === 'loading' && (
        <LoadingRegion label="Loading who has access">
          <SkeletonList rows={2} />
        </LoadingRegion>
      )}
      {grants.status === 'error' && (
        <Card>
          <p className="mb-4 text-base text-ink">We could not load who has access.</p>
          <Button variant="secondary" onClick={grants.reload}>
            Try again
          </Button>
        </Card>
      )}

      {grants.status === 'success' && (
        <div className="space-y-10">
          <section aria-labelledby="access-title">
            <h2 id="access-title" className="mb-4 font-display text-xl font-semibold text-ink">
              People with access
            </h2>
            {active.length === 0 ? (
              <Card className="flex items-center gap-4">
                <NavIcon name="sharing" className="h-7 w-7 shrink-0 text-sage-dark" />
                <p className="text-base text-ink">Nobody can see your reports yet. You decide who does.</p>
              </Card>
            ) : (
              <ul className="space-y-3">
                {active.map((grant) => (
                  <li key={grant.id}>
                    <Card className="flex flex-wrap items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 font-display text-lg font-semibold text-ink">
                          {nameOf(grant)}
                          {grant.grantee && <Badge tone="success">{roleLabel(grant.grantee.role)}</Badge>}
                        </p>
                        <Hint>
                          {grant.invited_email}
                          {grant.accepted_at && ` · since ${dateOfInstant(grant.accepted_at, zone)}`}
                        </Hint>
                      </div>
                      <Button variant="secondary" size="md" aria-label={`Revoke access for ${nameOf(grant)}`} onClick={() => setTarget(grant)}>
                        Revoke access
                      </Button>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="pending-title">
            <h2 id="pending-title" className="mb-4 font-display text-xl font-semibold text-ink">
              Pending invitations
            </h2>
            {pending.length === 0 ? (
              <Card>
                <p className="text-base text-ink">No invitations waiting.</p>
              </Card>
            ) : (
              <ul className="space-y-3">
                {pending.map((grant) => (
                  <li key={grant.id}>
                    <Card className="flex flex-wrap items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="font-display text-lg font-semibold text-ink">{grant.invited_email}</p>
                        <Hint>Invited {dateOfInstant(grant.created_at, zone)} · waiting for them to accept</Hint>
                      </div>
                      <Button variant="secondary" size="md" aria-label={`Cancel invitation to ${grant.invited_email}`} onClick={() => setTarget(grant)}>
                        Cancel invitation
                      </Button>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <Modal
        open={target !== null}
        onClose={close}
        title={target ? (target.status === 'pending' ? 'Cancel this invitation?' : `Revoke access for ${nameOf(target)}?`) : 'Revoke access'}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={revoking}>
              Keep it
            </Button>
            <Button variant="danger" loading={revoking} onClick={() => void confirmRevoke()}>
              {target?.status === 'pending' ? 'Cancel invitation' : 'Revoke access'}
            </Button>
          </>
        }
      >
        <p>
          {target?.status === 'pending'
            ? `${target.invited_email} will no longer be able to accept.`
            : 'They will not be able to see your reports from now on, and weekly summaries stop. Past views stay in your activity log. You can invite them again later.'}
        </p>
        {revokeError && (
          <p role="alert" className="mt-4 rounded-2xl border border-danger p-3 font-medium text-danger">
            {revokeError}
          </p>
        )}
      </Modal>
    </>
  )
}

function nameOf(grant: Grant): string {
  return grant.grantee ? displayName(grant.grantee) : grant.invited_email
}
