import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { homePathFor, useAuth } from '../auth/context'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { AuthLayout } from './AuthLayout'

export function LoginPage() {
  const { login, status, user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'authenticated' && user) return <Navigate to={homePathFor(user.role)} replace />

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const me = await login(email.trim(), password)
      const from = (location.state as { from?: string } | null)?.from
      navigate(from && from.startsWith('/') && from !== '/login' ? from : homePathFor(me.role), { replace: true })
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'That email and password do not match. Please try again.'
          : caught instanceof ApiError
            ? caught.message
            : 'Something went wrong. Please try again.',
      )
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to see today's doses and your reports.">
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {error && (
          <p role="alert" className="rounded-2xl border border-danger bg-surface p-4 text-base font-medium text-danger">
            {error}
          </p>
        )}
        <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" fullWidth loading={busy}>
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-base text-ink">
        New here?{' '}
        <Link to="/register" className="font-semibold text-sage-dark underline underline-offset-4">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  )
}
