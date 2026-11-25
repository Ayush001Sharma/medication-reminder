import { describe, expect, it, vi } from 'vitest'
import { fakeFetch, json, type RecordedCall } from '../test/helpers'
import { ApiError, createApiClient } from './client'
import { createTokenStore } from './tokenStore'

const BASE = 'http://api.test'

function setup(handler: (call: RecordedCall) => Response | Promise<Response>, signedIn = true) {
  const tokens = createTokenStore(window.sessionStorage)
  if (signedIn) tokens.set({ access: 'old-access', refresh: 'the-refresh' })
  const server = fakeFetch(handler)
  const client = createApiClient({ baseUrl: `${BASE}/`, tokens, fetchImpl: server.fetchImpl })
  const expired = vi.fn()
  client.onSessionExpired(expired)
  return { client, tokens, expired, ...server }
}

/** A server that rejects the old access token, accepts the new one, and issues new tokens on refresh. */
function expiringServer(refreshResponse: () => Response = () => json(200, { access: 'new-access' })) {
  return (call: RecordedCall) => {
    if (call.url.endsWith('/api/auth/refresh/')) return refreshResponse()
    if (call.headers.Authorization === 'Bearer new-access') return json(200, { ok: true, path: call.url })
    return json(401, { detail: 'Token is expired' })
  }
}

const refreshCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url.endsWith('/api/auth/refresh/'))

describe('requests', () => {
  it('joins the base URL, sends the bearer token and a JSON body', async () => {
    const { client, calls } = setup(() => json(200, { id: 1 }))
    await expect(client.post('/api/things/', { name: 'x' })).resolves.toEqual({ id: 1 })
    expect(calls[0]).toMatchObject({
      url: 'http://api.test/api/things/',
      method: 'POST',
      body: { name: 'x' },
      headers: { Authorization: 'Bearer old-access', 'Content-Type': 'application/json' },
    })
  })

  it('adds query parameters and skips undefined ones', async () => {
    const { client, calls } = setup(() => json(200, []))
    await client.get('/api/doses/upcoming/', { query: { days: 3, other: undefined } })
    expect(calls[0]?.url).toBe('http://api.test/api/doses/upcoming/?days=3')
  })

  it('sends no Authorization header when signed out, and none when auth is false', async () => {
    const out = setup(() => json(200, {}), false)
    await out.client.get('/api/x/')
    expect(out.calls[0]?.headers.Authorization).toBeUndefined()

    const publicCall = setup(() => json(200, {}))
    await publicCall.client.post('/api/auth/login/', {}, { auth: false })
    expect(publicCall.calls[0]?.headers.Authorization).toBeUndefined()
  })

  it('returns undefined for 204 and plain text for non-JSON', async () => {
    const empty = setup(() => new Response(null, { status: 204 }))
    await expect(empty.client.delete('/api/x/1/')).resolves.toBeUndefined()
    const text = setup(() => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }))
    await expect(text.client.get('/api/x/')).resolves.toBe('hello')
  })
})

describe('refreshing an expired access token', () => {
  it('refreshes ONCE on a 401, retries with the new token and stores it', async () => {
    const { client, calls, tokens, expired } = setup(expiringServer())

    await expect(client.get('/api/me/')).resolves.toMatchObject({ ok: true })

    expect(calls.map((c) => `${c.method} ${c.url.replace(BASE, '')} ${c.headers.Authorization ?? '-'}`)).toEqual([
      'GET /api/me/ Bearer old-access',
      'POST /api/auth/refresh/ -',
      'GET /api/me/ Bearer new-access',
    ])
    expect(calls[1]?.body).toEqual({ refresh: 'the-refresh' })
    expect(tokens.get()).toEqual({ access: 'new-access', refresh: 'the-refresh' }) // refresh token kept
    expect(JSON.parse(window.sessionStorage.getItem('medreminder.session') ?? '{}').access).toBe('new-access')
    expect(expired).not.toHaveBeenCalled()
  })

  it('keeps a rotated refresh token when the server sends one', async () => {
    const { client, tokens } = setup(expiringServer(() => json(200, { access: 'new-access', refresh: 'rotated' })))
    await client.get('/api/me/')
    expect(tokens.get()).toEqual({ access: 'new-access', refresh: 'rotated' })
  })

  it('shares ONE refresh between requests that fail at the same time', async () => {
    const { client, calls } = setup(expiringServer())
    const results = await Promise.all([client.get('/api/a/'), client.get('/api/b/'), client.get('/api/c/')])
    expect(results).toHaveLength(3)
    expect(refreshCalls(calls)).toHaveLength(1)
  })

  it('a later expiry refreshes again (the shared refresh is not cached forever)', async () => {
    let issued = 0
    const { client, calls, tokens } = setup((call) => {
      if (call.url.endsWith('/api/auth/refresh/')) return json(200, { access: `access-${++issued}` })
      return call.headers.Authorization === `Bearer access-${issued}` && issued > 0 ? json(200, {}) : json(401, {})
    })
    await client.get('/api/a/')
    tokens.set({ access: 'stale-again', refresh: 'the-refresh' })
    await client.get('/api/b/')
    expect(refreshCalls(calls)).toHaveLength(2)
  })

  it('does not refresh for other errors such as 403 or 404', async () => {
    for (const status of [403, 404, 400]) {
      const { client, calls, expired } = setup(() => json(status, { detail: 'nope' }))
      await expect(client.get('/api/x/')).rejects.toMatchObject({ status })
      expect(refreshCalls(calls)).toHaveLength(0)
      expect(expired).not.toHaveBeenCalled()
    }
  })
})

describe('logging out when the session cannot be saved', () => {
  async function expectSessionEnded(client: ReturnType<typeof setup>['client'], tokens: ReturnType<typeof setup>['tokens'], expired: () => void) {
    await expect(client.get('/api/me/')).rejects.toMatchObject({ name: 'ApiError', status: 401 })
    expect(tokens.get()).toBeNull()
    expect(window.sessionStorage.getItem('medreminder.session')).toBeNull()
    expect(expired).toHaveBeenCalledTimes(1)
  }

  it('refresh token rejected (401)', async () => {
    const { client, tokens, expired, calls } = setup(expiringServer(() => json(401, { detail: 'Token is invalid or expired' })))
    await expectSessionEnded(client, tokens, expired)
    expect(calls.map((c) => c.method + c.url.replace(BASE, ''))).toEqual(['GET/api/me/', 'POST/api/auth/refresh/']) // no retry, no loop
  })

  it('refresh request fails at the network level', async () => {
    const { client, tokens, expired } = setup((call) => {
      if (call.url.endsWith('/api/auth/refresh/')) throw new TypeError('Failed to fetch')
      return json(401, {})
    })
    await expectSessionEnded(client, tokens, expired)
  })

  it('refresh answers 200 without an access token', async () => {
    const { client, tokens, expired } = setup(expiringServer(() => json(200, { nope: true })))
    await expectSessionEnded(client, tokens, expired)
  })

  it('the retry with a brand-new token is still refused: no second refresh, session ends', async () => {
    const { client, tokens, expired, calls } = setup((call) =>
      call.url.endsWith('/api/auth/refresh/') ? json(200, { access: 'new-access' }) : json(401, {}),
    )
    await expectSessionEnded(client, tokens, expired)
    expect(refreshCalls(calls)).toHaveLength(1)
  })

  it('notifies every listener, and unsubscribing stops notifications', async () => {
    const { client, expired } = setup(expiringServer(() => json(401, {})))
    const other = vi.fn()
    const unsubscribe = client.onSessionExpired(other)
    unsubscribe()
    await expect(client.get('/api/me/')).rejects.toBeInstanceOf(ApiError)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
  })
})

describe('calls that must never trigger a refresh', () => {
  it('a 401 on sign-in (auth: false) is just "wrong password"', async () => {
    const { client, calls, tokens, expired } = setup(() => json(401, { detail: 'No active account found with the given credentials' }))
    await expect(client.post('/api/auth/login/', { email: 'a', password: 'b' }, { auth: false })).rejects.toMatchObject({
      status: 401,
      message: 'No active account found with the given credentials',
    })
    expect(refreshCalls(calls)).toHaveLength(0)
    expect(tokens.get()).not.toBeNull()
    expect(expired).not.toHaveBeenCalled()
  })

  it('a 401 while signed out does not try to refresh or announce an expiry', async () => {
    const { client, calls, expired } = setup(() => json(401, { detail: 'Authentication credentials were not provided.' }), false)
    await expect(client.get('/api/me/')).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(1)
    expect(expired).not.toHaveBeenCalled()
  })
})

describe('error messages', () => {
  it('turns a rate limit into a friendly message with the wait time', async () => {
    const { client } = setup(() => json(429, { detail: 'Request was throttled.' }, { 'retry-after': '42' }))
    const error = await client.get('/api/x/').catch((e: ApiError) => e)
    expect(error).toMatchObject({ status: 429, retryAfter: 42 })
    expect((error as ApiError).message).toBe('Too many attempts. Please wait 42 seconds and try again.')
  })

  it('has a message for a 429 without Retry-After, a 500, and an unreachable server', async () => {
    await expect(setup(() => json(429, {})).client.get('/x')).rejects.toMatchObject({ message: expect.stringContaining('Too many attempts') })
    await expect(setup(() => json(503, {})).client.get('/x')).rejects.toMatchObject({ message: expect.stringContaining('our side') })
    const down = setup(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(down.client.get('/x')).rejects.toMatchObject({ status: 0, message: expect.stringContaining("Can't reach the server") })
  })

  it('exposes Django field errors', async () => {
    const { client } = setup(() => json(400, { email: ['A user with this email already exists.'], timezone: ['Required.'] }))
    const error = (await client.post('/api/auth/register/', {}, { auth: false }).catch((e: ApiError) => e)) as ApiError
    expect(error.fieldErrors).toEqual({ email: 'A user with this email already exists.', timezone: 'Required.' })
    expect(error.message).toBe('A user with this email already exists.')
  })

  it("flattens DRF's nested list errors (a bad item in a list field)", async () => {
    const { client } = setup(() => json(400, { times_of_day: { '0': ['Time has wrong format. Use one of these formats instead: hh:mm.'] }, days_of_week: [['Ensure this value is less than or equal to 6.']] }))
    const error = (await client.post('/api/medications/1/schedules/', {}).catch((e: ApiError) => e)) as ApiError
    expect(error.fieldErrors).toEqual({
      times_of_day: 'Time has wrong format. Use one of these formats instead: hh:mm.',
      days_of_week: 'Ensure this value is less than or equal to 6.',
    })
    expect(error.message).toBe('Time has wrong format. Use one of these formats instead: hh:mm.')
  })

  it('lets an aborted request surface as an AbortError, not an ApiError', async () => {
    const controller = new AbortController()
    const { client } = setup(() => {
      throw new DOMException('Aborted', 'AbortError')
    })
    controller.abort()
    await expect(client.get('/x', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('the shared instance', () => {
  it('reads VITE_API_BASE_URL', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_API_BASE_URL', 'http://configured.example:9000')
    const fetchMock = vi.fn(async () => json(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await import('./client')
    await api.get('/health/')
    expect(fetchMock).toHaveBeenCalledWith('http://configured.example:9000/health/', expect.any(Object))
  })
})
