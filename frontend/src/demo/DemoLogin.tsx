import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { homePathFor, useAuth } from '../auth/context'
import { Button } from '../components/ui/Button'
import { DEMO_ACCOUNTS, DEMO_PASSWORD, type DemoAccount } from './accounts'

/**
 * One-click sign-in with the accounts made by `seed_demo`. Rendered only in a demo build (see LoginPage), and
 * clearly labelled so nobody mistakes it for the real sign-in.
 */
export default function DemoLogin() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [busyId, setBusyId] = useState<DemoAccount['id'] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function signIn(account: DemoAccount) {
    if (busyId) return
    setBusyId(account.id)
    setError(null)
    try {
      const me = await login(account.email, DEMO_PASSWORD)
      navigate(homePathFor(me.role), { replace: true })
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'The demo account was not found. Has "python manage.py seed_demo" been run on this backend?'
          : caught instanceof ApiError
            ? caught.message
            : 'Something went wrong. Please try again.',
      )
      setBusyId(null)
    }
  }

  return (
    <section aria-labelledby="demo-title" className="mt-8 rounded-2xl border border-dashed border-sage bg-sage-tint p-4">
      <h2 id="demo-title" className="font-display text-lg font-semibold text-ink">
        Demo mode
      </h2>
      <p className="mb-4 mt-1 text-sm text-ink">One click signs you in with the sample accounts from the seed command. For local development only.</p>
      {error && (
        <p role="alert" className="mb-4 rounded-2xl border border-danger bg-surface p-3 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <div className="grid gap-3">
        {DEMO_ACCOUNTS.map((account) => (
          <Button key={account.id} variant="secondary" size="md" loading={busyId === account.id} disabled={busyId !== null} onClick={() => void signIn(account)}>
            {account.label}
          </Button>
        ))}
      </div>
    </section>
  )
}
