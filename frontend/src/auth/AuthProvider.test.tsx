import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../api/client'
import { createTokenStore } from '../api/tokenStore'
import { fakeFetch, json, makeUser, type RecordedCall } from '../test/helpers'
import { ToastProvider } from '../toast/ToastProvider'
import { AuthProvider } from './AuthProvider'
import { useAuth } from './context'

function Probe() {
  const { user, status, login, register, logout } = useAuth()
  return (
    <div>
      <p data-testid="state">{status}:{user?.email ?? 'nobody'}</p>
      <button onClick={() => login('asha@example.com', 'pw').catch((e: Error) => document.body.setAttribute('data-error', e.message))}>login</button>
      <button onClick={() => register({ email: 'new@example.com', password: 'pw', fullName: 'New Person', role: 'patient', timezone: 'Asia/Kolkata' }).catch(() => undefined)}>register-patient</button>
      <button onClick={() => register({ email: 'doc@example.com', password: 'pw', fullName: 'Doc', role: 'doctor', timezone: 'Asia/Kolkata' }).catch(() => undefined)}>register-doctor</button>
      <button onClick={logout}>logout</button>
    </div>
  )
}

function mount(handler: (call: RecordedCall) => Response, savedTokens = false) {
  const tokens = createTokenStore(window.sessionStorage)
  if (savedTokens) tokens.set({ access: 'saved-access', refresh: 'saved-refresh' })
  const server = fakeFetch(handler)
  const client = createApiClient({ baseUrl: 'http://api.test', tokens, fetchImpl: server.fetchImpl })
  render(
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider client={client} tokens={tokens}>
          <Probe />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  )
  return { tokens, client, ...server }
}

const state = () => screen.getByTestId('state').textContent

describe('AuthProvider', () => {
  it('starts signed out when there is no saved session, without calling the server', () => {
    const { calls } = mount(() => json(500, {}))
    expect(state()).toBe('anonymous:nobody')
    expect(calls).toHaveLength(0)
  })

  it('restores a saved session by asking the server who you are', async () => {
    const { calls } = mount(() => json(200, makeUser('patient')), true)
    expect(state()).toBe('loading:nobody')
    await waitFor(() => expect(state()).toBe('authenticated:patient@example.com'))
    expect(calls[0]?.headers.Authorization).toBe('Bearer saved-access')
  })

  it('a saved session the server rejects ends signed out, with a notice', async () => {
    const { tokens } = mount((call) => (call.url.endsWith('/refresh/') ? json(401, {}) : json(401, {})), true)
    await waitFor(() => expect(state()).toBe('anonymous:nobody'))
    expect(tokens.get()).toBeNull()
    expect(await screen.findByRole('status')).toHaveTextContent('Your session ended')
  })

  it('keeps the saved session when the server is merely unreachable', async () => {
    const { tokens } = mount(() => {
      throw new TypeError('Failed to fetch')
    }, true)
    await waitFor(() => expect(state()).toBe('anonymous:nobody'))
    expect(tokens.get()).not.toBeNull()
  })

  it('signs in: stores the tokens, loads the profile, never sends the token to the sign-in call', async () => {
    const { tokens, calls } = mount((call) =>
      call.url.endsWith('/api/auth/login/') ? json(200, { access: 'A', refresh: 'R' }) : json(200, makeUser('patient')),
    )
    await userEvent.click(screen.getByText('login'))
    await waitFor(() => expect(state()).toBe('authenticated:patient@example.com'))
    expect(tokens.get()).toEqual({ access: 'A', refresh: 'R' })
    expect(calls[0]).toMatchObject({ method: 'POST', body: { email: 'asha@example.com', password: 'pw' } })
    expect(calls[0]?.headers.Authorization).toBeUndefined()
    expect(calls[1]?.headers.Authorization).toBe('Bearer A')
  })

  it('a wrong password leaves you signed out with nothing stored', async () => {
    const { tokens } = mount(() => json(401, { detail: 'No active account found with the given credentials' }))
    await userEvent.click(screen.getByText('login'))
    await waitFor(() => expect(document.body.getAttribute('data-error')).toBe('No active account found with the given credentials'))
    expect(state()).toBe('anonymous:nobody')
    expect(tokens.get()).toBeNull()
  })

  it('does not keep tokens if the profile cannot be loaded right after signing in', async () => {
    const { tokens } = mount((call) => (call.url.endsWith('/login/') ? json(200, { access: 'A', refresh: 'R' }) : json(500, {})))
    await userEvent.click(screen.getByText('login'))
    await waitFor(() => expect(document.body.getAttribute('data-error')).toBeTruthy())
    expect(tokens.get()).toBeNull()
    expect(state()).toBe('anonymous:nobody')
  })

  it('registers a patient with their timezone, then signs them in', async () => {
    const { calls } = mount((call) => {
      if (call.url.endsWith('/register/')) return json(201, {})
      if (call.url.endsWith('/login/')) return json(200, { access: 'A', refresh: 'R' })
      return json(200, makeUser('patient', { email: 'new@example.com' }))
    })
    await userEvent.click(screen.getByText('register-patient'))
    await waitFor(() => expect(state()).toBe('authenticated:new@example.com'))
    expect(calls[0]?.body).toEqual({ email: 'new@example.com', password: 'pw', full_name: 'New Person', role: 'patient', timezone: 'Asia/Kolkata' })
  })

  it('does not send a timezone for caregivers and doctors', async () => {
    const { calls } = mount((call) => (call.url.endsWith('/register/') ? json(201, {}) : json(400, {})))
    await userEvent.click(screen.getByText('register-doctor'))
    await waitFor(() => expect(calls.length).toBeGreaterThan(1))
    expect(calls[0]?.body).toEqual({ email: 'doc@example.com', password: 'pw', full_name: 'Doc', role: 'doctor' })
  })

  it('signs out: forgets the tokens and the user', async () => {
    const { tokens } = mount(() => json(200, makeUser('doctor')), true)
    await waitFor(() => expect(state()).toBe('authenticated:doctor@example.com'))
    await userEvent.click(screen.getByText('logout'))
    expect(state()).toBe('anonymous:nobody')
    expect(tokens.get()).toBeNull()
    expect(window.sessionStorage.length).toBe(0)
  })

  it('signs you out, with a notice, when the session expires while you are using the app', async () => {
    let serverAcceptsTokens = true
    const { client, tokens } = mount((call) => {
      if (call.url.endsWith('/refresh/')) return json(401, { detail: 'Token is invalid or expired' })
      return serverAcceptsTokens ? json(200, call.url.endsWith('/api/me/') ? makeUser('patient') : []) : json(401, {})
    }, true)
    await waitFor(() => expect(state()).toBe('authenticated:patient@example.com'))

    serverAcceptsTokens = false // the access token expires AND the refresh token is no longer accepted
    await expect(client.get('/api/doses/today/')).rejects.toMatchObject({ status: 401 })

    await waitFor(() => expect(state()).toBe('anonymous:nobody'))
    expect(tokens.get()).toBeNull()
    expect(await screen.findByRole('status')).toHaveTextContent('Your session ended. Please sign in again.')
  })
})
