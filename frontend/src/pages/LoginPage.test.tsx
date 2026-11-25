import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { expectNoA11yViolations } from '../test/axe'
import type { AuthValue } from '../auth/context'
import { authValue, makeUser, renderWithProviders } from '../test/helpers'
import { LoginPage } from './LoginPage'

function renderLogin(login: AuthValue['login'], route: string | { pathname: string; state?: unknown } = '/login') {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/today" element={<p>Today page</p>} />
      <Route path="/patients" element={<p>Patients page</p>} />
      <Route path="/medications" element={<p>Medications page</p>} />
    </Routes>,
    { route, auth: authValue(null, { login }) },
  )
}

async function fillAndSubmit(email = '  asha@example.com ', password = 'secret-pass') {
  await userEvent.type(screen.getByLabelText('Email'), email)
  await userEvent.type(screen.getByLabelText('Password'), password)
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('LoginPage', () => {
  it('shows no demo mode unless the build turned it on', () => {
    renderLogin(vi.fn())
    expect(screen.queryByText(/Try as/)).not.toBeInTheDocument()
    expect(screen.queryByText('Demo mode')).not.toBeInTheDocument()
  })

  it('signs in with a trimmed email and lands on the role home', async () => {
    const login = vi.fn<AuthValue['login']>().mockResolvedValue(makeUser('caregiver'))
    renderLogin(login)
    await fillAndSubmit()
    expect(login).toHaveBeenCalledWith('asha@example.com', 'secret-pass')
    expect(await screen.findByText('Patients page')).toBeInTheDocument()
  })

  it('goes back to the page you were trying to reach', async () => {
    renderLogin(vi.fn<AuthValue['login']>().mockResolvedValue(makeUser('patient')), { pathname: '/login', state: { from: '/medications' } })
    await fillAndSubmit()
    expect(await screen.findByText('Medications page')).toBeInTheDocument()
  })

  it('ignores a "from" that is not an in-app path', async () => {
    renderLogin(vi.fn<AuthValue['login']>().mockResolvedValue(makeUser('patient')), { pathname: '/login', state: { from: 'https://evil.example/' } })
    await fillAndSubmit()
    expect(await screen.findByText('Today page')).toBeInTheDocument()
  })

  it('shows a clear message for wrong credentials and lets you try again', async () => {
    const login = vi.fn<AuthValue['login']>().mockRejectedValue(new ApiError(401, 'No active account found'))
    renderLogin(login)
    await fillAndSubmit()
    expect(await screen.findByRole('alert')).toHaveTextContent('That email and password do not match')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('tells the user how long to wait when rate limited', async () => {
    renderLogin(vi.fn<AuthValue['login']>().mockRejectedValue(new ApiError(429, 'Too many attempts. Please wait 42 seconds and try again.', undefined, 42)))
    await fillAndSubmit()
    expect(await screen.findByRole('alert')).toHaveTextContent('wait 42 seconds')
  })

  it('shows a helpful message when the server cannot be reached, or on any unexpected error', async () => {
    renderLogin(vi.fn<AuthValue['login']>().mockRejectedValueOnce(new ApiError(0, "Can't reach the server. Check your connection and try again.")).mockRejectedValueOnce(new Error('boom')))
    await fillAndSubmit()
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server")
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong'))
  })

  it('disables the button while signing in, so it cannot be double-submitted', async () => {
    let finish: (value: ReturnType<typeof makeUser>) => void = () => undefined
    const login = vi.fn<AuthValue['login']>(() => new Promise<ReturnType<typeof makeUser>>((resolve) => (finish = resolve)))
    renderLogin(login)
    await fillAndSubmit()
    const button = screen.getByRole('button', { name: 'Sign in' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    finish(makeUser('patient'))
    expect(await screen.findByText('Today page')).toBeInTheDocument()
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('uses the right input types and autocomplete hints', () => {
    renderLogin(vi.fn<AuthValue['login']>())
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/register')
  })

  it('has no accessibility violations, with or without an error showing', async () => {
    const { container } = renderLogin(vi.fn<AuthValue['login']>().mockRejectedValue(new ApiError(401, 'x')))
    await expectNoA11yViolations(container)
    await fillAndSubmit()
    await screen.findByRole('alert')
    await expectNoA11yViolations(container)
  })
})
