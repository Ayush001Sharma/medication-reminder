import { screen } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { App } from '../App'
import type { Role } from '../api/types'
import { authValue, makeUser, renderWithProviders } from '../test/helpers'
import { ProtectedRoute } from './ProtectedRoute'

function LoginProbe() {
  const location = useLocation()
  return <p>Login page (came from {(location.state as { from?: string } | null)?.from ?? 'nowhere'})</p>
}

function renderGuarded(role: Role | null, roles?: Role[], status?: 'loading') {
  const user = role ? makeUser(role) : null
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginProbe />} />
      <Route element={<ProtectedRoute roles={roles} />}>
        <Route path="/secret" element={<p>Secret content</p>} />
      </Route>
    </Routes>,
    { route: '/secret?tab=2', auth: authValue(user, {}, status) },
  )
}

describe('ProtectedRoute', () => {
  it('shows a loading state, not the page and not a redirect, while the account is being checked', () => {
    renderGuarded('patient', undefined, 'loading')
    expect(screen.getByRole('status')).toHaveTextContent('Loading your account')
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument()
    expect(screen.queryByText(/Login page/)).not.toBeInTheDocument()
  })

  it('sends a signed-out visitor to /login and remembers where they were going', () => {
    renderGuarded(null)
    expect(screen.getByText('Login page (came from /secret?tab=2)')).toBeInTheDocument()
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument()
  })

  it('lets any signed-in user through when no roles are required', () => {
    renderGuarded('caregiver')
    expect(screen.getByText('Secret content')).toBeInTheDocument()
  })

  it.each<Role>(['patient', 'doctor'])('lets a %s through when their role is allowed', (role) => {
    renderGuarded(role, ['patient', 'doctor'])
    expect(screen.getByText('Secret content')).toBeInTheDocument()
  })

  it('shows a "not available" page, with a way home, when the role is not allowed', () => {
    renderGuarded('patient', ['doctor'])
    expect(screen.getByRole('heading', { level: 1, name: /not available to your account/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /go to my home page/i })).toHaveAttribute('href', '/today')
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument()
  })

  it('treats an unauthenticated status as signed out even if a user object lingers', () => {
    const lingering = authValue(makeUser('patient'), {}, 'anonymous')
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginProbe />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/secret" element={<p>Secret content</p>} />
        </Route>
      </Routes>,
      { route: '/secret', auth: lingering },
    )
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument()
  })
})

describe('the real route table', () => {
  const visit = (role: Role | null, route: string) =>
    renderWithProviders(<App />, { route, auth: authValue(role ? makeUser(role) : null) })

  it('keeps signed-out visitors out of every app page', () => {
    for (const route of ['/today', '/medications', '/patients', '/invitations']) {
      const { unmount } = visit(null, route)
      expect(screen.getByRole('heading', { name: /welcome back/i })).toBeInTheDocument()
      unmount()
    }
  })

  it.each([
    ['patient', '/patients'],
    ['patient', '/invitations'],
    ['patient', '/patients/5'],
    ['caregiver', '/today'],
    ['caregiver', '/sharing'],
    ['doctor', '/medications'],
    ['doctor', '/activity'],
    ['caregiver', '/upcoming'],
    ['doctor', '/medications/new'],
    ['caregiver', '/medications/1/edit'],
  ] as const)('blocks a %s from %s', (role, route) => {
    visit(role, route)
    expect(screen.getByRole('heading', { name: /not available to your account/i })).toBeInTheDocument()
  })

  it('"/" sends each role to its own home', () => {
    visit('patient', '/')
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeInTheDocument()
  })

  it('lets a patient reach every patient page, including the medication form routes', () => {
    for (const [route, heading] of [
      ['/today', 'Today'], ['/upcoming', 'Upcoming'], ['/medications', 'Medications'],
      ['/medications/new', 'Add medication'], ['/medications/1/edit', 'Edit medication'], ['/sharing', 'Sharing'], ['/activity', 'Activity'],
    ] as const) {
      const { unmount } = visit('patient', route)
      expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
      unmount()
    }
  })

  it.each([['caregiver'], ['doctor']] as const)('lets a %s reach the invitations page and a patient report', (role) => {
    for (const [route, heading] of [['/patients', 'Patients'], ['/invitations', 'Invitations'], ['/patients/5', 'Adherence report']] as const) {
      const { unmount } = visit(role, route)
      expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
      unmount()
    }
  })

  it('shows a not-found page inside the shell for an unknown address', () => {
    visit('doctor', '/no/such/page')
    expect(screen.getByRole('heading', { name: /could not find that page/i })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument()
  })

  it('moves a signed-in user away from the sign-in page', () => {
    visit('caregiver', '/login')
    expect(screen.getByRole('heading', { name: 'Patients' })).toBeInTheDocument()
  })
})
