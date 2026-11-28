import { useState } from 'react'
import { api, ApiError } from '../../api/client'
import type { Invitation } from '../../api/types'
import { useAsync } from '../../hooks/useAsync'
import { displayName } from '../../lib/report'
import { dateOfInstant, zoneOf } from '../../lib/dates'
import { useAuth } from '../../auth/context'
import { useToast } from '../../toast/context'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Hint } from '../ui/Hint'
import { LoadingRegion, Skeleton } from '../ui/Skeleton'

/**
 * Invitations from patients, with an Accept button each. Fails on its own (the patient list beside it keeps
 * working) and calls `onAccepted` so that list can refresh.
 */
export function InvitationsPanel({ onAccepted, showHeading = true }: { onAccepted?: () => void; showHeading?: boolean }) {
  const toast = useToast()
  const zone = zoneOf(useAuth().user?.patient_profile)
  const invitations = useAsync((signal) => api.get<Invitation[]>('/api/access/invitations/', { signal }))
  const [accepting, setAccepting] = useState<number | null>(null)
  const [accepted, setAccepted] = useState<ReadonlySet<number>>(new Set())

  async function accept(invitation: Invitation) {
    if (accepting !== null) return
    setAccepting(invitation.id)
    const who = displayName(invitation.patient)
    try {
      await api.post(`/api/access/invitations/${invitation.id}/accept/`)
      setAccepted((previous) => new Set(previous).add(invitation.id))
      toast.success(`You can now see ${who}'s adherence reports.`)
      onAccepted?.()
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // The patient withdrew it (or it was already dealt with) while this page was open.
        setAccepted((previous) => new Set(previous).add(invitation.id))
        toast.info(`The invitation from ${who} is no longer available. They can invite you again if they still want to share.`)
      } else {
        toast.error(error instanceof ApiError ? error.message : 'Something went wrong. Please try again.')
      }
    } finally {
      setAccepting(null)
      invitations.reload()
    }
  }

  const pending = invitations.status === 'success' ? invitations.data.filter((i) => !accepted.has(i.id)) : []
  return (
    <section aria-labelledby="invitations-title">
      <h2 id="invitations-title" className={showHeading ? 'mb-4 font-display text-xl font-semibold text-ink' : 'sr-only'}>
        Pending invitations
      </h2>
      {invitations.status === 'loading' && (
        <LoadingRegion label="Loading invitations">
          <Skeleton className="h-24 w-full rounded-2xl" />
        </LoadingRegion>
      )}
      {invitations.status === 'error' && (
        <Card>
          <p className="mb-4 text-base text-ink">We could not load your invitations.</p>
          <Button variant="secondary" size="md" onClick={invitations.reload}>
            Try again
          </Button>
        </Card>
      )}
      {invitations.status === 'success' && pending.length === 0 && (
        <Card>
          <p className="text-base text-ink">No pending invitations.</p>
          <Hint className="mt-1">When a patient invites you, it appears here and you can accept it.</Hint>
        </Card>
      )}
      {invitations.status === 'success' && pending.length > 0 && (
        <ul className="space-y-3">
          {pending.map((invitation) => {
            const who = displayName(invitation.patient)
            return (
              <li key={invitation.id}>
                <Card className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-display text-lg font-semibold text-ink">{who}</p>
                    <Hint>
                      Wants to share their adherence reports with you · invited {dateOfInstant(invitation.created_at, zone)}
                    </Hint>
                  </div>
                  <Button
                    aria-label={`Accept invitation from ${who}`}
                    loading={accepting === invitation.id}
                    disabled={accepting !== null}
                    onClick={() => void accept(invitation)}
                  >
                    Accept
                  </Button>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
