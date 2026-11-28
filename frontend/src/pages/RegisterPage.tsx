import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import type { Role } from '../api/types'
import { homePathFor, useAuth } from '../auth/context'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Combobox } from '../components/ui/Combobox'
import { Select } from '../components/ui/Select'
import { timezoneChoices, timezoneOptions } from '../lib/timezones'
import { AuthLayout } from './AuthLayout'
import { useFocusFirstInvalid } from '../hooks/useFocusFirstInvalid'
import { usePageTitle } from '../hooks/usePageTitle'

export function RegisterPage() {
  usePageTitle('Create account')
  const { register, status, user } = useAuth()
  const navigate = useNavigate()
  const detected = useMemo(() => timezoneOptions().detected, [])
  const choices = useMemo(() => timezoneChoices(), [])
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('patient')
  const [timezone, setTimezone] = useState(detected)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  useFocusFirstInvalid(formRef, fieldErrors)

  if (status === 'authenticated' && user) return <Navigate to={homePathFor(user.role)} replace />

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setFieldErrors({})
    setFormError(null)
    setBusy(true)
    try {
      const me = await register({ fullName: fullName.trim(), email: email.trim(), password, role, timezone })
      navigate(homePathFor(me.role), { replace: true })
    } catch (caught) {
      if (caught instanceof ApiError && Object.keys(caught.fieldErrors).length > 0) {
        setFieldErrors(caught.fieldErrors)
      } else {
        setFormError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.')
      }
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Create your account" subtitle="Patients track their own doses. Caregivers and doctors see what patients choose to share.">
      <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-5">
        {formError && (
          <p role="alert" className="rounded-2xl border border-danger bg-surface p-4 text-base font-medium text-danger">
            {formError}
          </p>
        )}
        <Input label="Full name" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} error={fieldErrors.full_name} />
        <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={fieldErrors.email} />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          hint="At least 8 characters; avoid common passwords."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />
        <Select label="I am a" value={role} onChange={(e) => setRole(e.target.value as Role)} error={fieldErrors.role}>
          <option value="patient">Patient</option>
          <option value="caregiver">Caregiver</option>
          <option value="doctor">Doctor</option>
        </Select>
        {role === 'patient' && (
          <Combobox
            label="Your timezone"
            hint="Reminders are sent at your local clock times. Type a city or region to search."
            options={choices}
            value={timezone}
            onChange={setTimezone}
            error={fieldErrors.timezone}
            emptyText="No matching time zones"
          />
        )}
        <Button type="submit" fullWidth loading={busy}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-base text-ink">
        Already registered?{' '}
        <Link to="/login" className="font-semibold text-sage-dark underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  )
}
