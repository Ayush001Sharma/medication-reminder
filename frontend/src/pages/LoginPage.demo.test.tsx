// Demo mode is a build-time switch, so this file turns it on BEFORE anything is imported (vi.hoisted runs first).
// Other test files keep the default (off); LoginPage.test.tsx asserts that.
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import type { AuthValue } from '../auth/context'
import { expectNoA11yViolations } from '../test/axe'
import { authValue, makeUser, renderWithProviders } from '../test/helpers'
import { LoginPage } from './LoginPage'

vi.hoisted(() => {
  vi.stubEnv('VITE_DEMO_MODE', 'true')
})

function renderLogin(login: AuthValue['login']) {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/today" element={<p>Today page</p>} />
      <Route path="/patients" element={<p>Patients page</p>} />
    </Routes>,
    { route: '/login', auth: authValue(null, { login }) },
  )
}

describe('LoginPage in demo mode', () => {
  it('offers the four one-click buttons, labelled as demo mode', async () => {
    renderLogin(vi.fn())
    const section = await screen.findByRole('region', { name: 'Demo mode' })
    expect(section).toHaveTextContent(/local development only/i)
    const labels = Array.from(section.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(['Try as patient (Kolkata)', 'Try as patient (New York)', 'Try as caregiver', 'Try as doctor'])
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument() // the real form is still there
  })

  it.each([
    ['Try as patient (Kolkata)', 'demo.asha@example.com', 'patient', 'Today page'],
    ['Try as patient (New York)', 'demo.ben@example.com', 'patient', 'Today page'],
    ['Try as caregiver', 'demo.carla@example.com', 'caregiver', 'Patients page'],
    ['Try as doctor', 'demo.dr.rao@example.com', 'doctor', 'Patients page'],
  ] as const)('%s signs in as the seed_demo account and lands on the role home', async (label, email, role, landing) => {
    const login = vi.fn().mockResolvedValue(makeUser(role))
    renderLogin(login)
    await userEvent.click(await screen.findByRole('button', { name: label }))
    expect(login).toHaveBeenCalledWith(email, 'demo-password-123')
    expect(await screen.findByText(landing)).toBeInTheDocument()
  })

  it('disables the other buttons while one is signing in, and ignores a second click', async () => {
    let finish: (me: ReturnType<typeof makeUser>) => void = () => undefined
    const login = vi.fn().mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    renderLogin(login)
    const doctor = await screen.findByRole('button', { name: 'Try as doctor' })
    await userEvent.click(doctor)
    expect(doctor).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Try as caregiver' })).toBeDisabled()
    await userEvent.click(doctor)
    expect(login).toHaveBeenCalledTimes(1)
    finish(makeUser('doctor'))
    expect(await screen.findByText('Patients page')).toBeInTheDocument()
  })

  it('explains what to do when the demo account does not exist (seed not run)', async () => {
    const login = vi.fn().mockRejectedValue(new ApiError(401, 'No active account found.'))
    renderLogin(login)
    await userEvent.click(await screen.findByRole('button', { name: 'Try as caregiver' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('python manage.py seed_demo')
    expect(screen.getByRole('button', { name: 'Try as caregiver' })).toBeEnabled() // can try again
  })

  it('has no accessibility violations', async () => {
    const { container } = renderLogin(vi.fn())
    await screen.findByRole('region', { name: 'Demo mode' })
    await expectNoA11yViolations(container)
  })
})
