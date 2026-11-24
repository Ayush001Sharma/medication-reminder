import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { Me, Role } from '../api/types'
import { AuthContext, type AuthStatus, type AuthValue } from '../auth/context'
import { ToastProvider } from '../toast/ToastProvider'

export function makeUser(role: Role = 'patient', overrides: Partial<Me> = {}): Me {
  return {
    id: 1,
    email: `${role}@example.com`,
    full_name: role === 'patient' ? 'Asha Patel' : role === 'doctor' ? 'Dr. Rao' : 'Carla Mendes',
    role,
    patient_profile: role === 'patient' ? { timezone: 'Asia/Kolkata', phone_number: '', notification_preferences: {} } : null,
    ...overrides,
  }
}

export function authValue(user: Me | null, overrides: Partial<AuthValue> = {}, status?: AuthStatus): AuthValue {
  return {
    user,
    status: status ?? (user ? 'authenticated' : 'anonymous'),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  }
}

/** Render inside a router, the toast provider and a fixed auth state. */
export function renderWithProviders(ui: ReactElement, options: { route?: string | { pathname: string; state?: unknown }; auth?: AuthValue } = {}) {
  const auth = options.auth ?? authValue(null)
  return {
    auth,
    ...render(
      <MemoryRouter initialEntries={[options.route ?? '/']}>
        <ToastProvider>
          <AuthContext.Provider value={auth}>{ui}</AuthContext.Provider>
        </ToastProvider>
      </MemoryRouter>,
    ),
  }
}

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** A fake fetch that records every call and answers with whatever the handler returns. */
export function fakeFetch(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}
