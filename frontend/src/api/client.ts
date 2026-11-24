import { createTokenStore, type TokenStore } from './tokenStore'

/** An HTTP error from the API (or status 0 when the server could not be reached at all). */
export class ApiError extends Error {
  readonly status: number
  readonly data: unknown
  /** Seconds to wait before retrying, from the Retry-After header on a 429. */
  readonly retryAfter: number | null

  constructor(status: number, message: string, data: unknown = undefined, retryAfter: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
    this.retryAfter = retryAfter
  }

  /** Django REST Framework field errors ({ email: ["..."] }) as { email: "..." }. */
  get fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {}
    if (typeof this.data === 'object' && this.data !== null && !Array.isArray(this.data)) {
      for (const [field, value] of Object.entries(this.data as Record<string, unknown>)) {
        if (field === 'detail') continue
        const first = Array.isArray(value) ? value[0] : value
        if (typeof first === 'string') result[field] = first
      }
    }
    return result
  }
}

function messageFor(status: number, data: unknown, retryAfter: number | null): string {
  if (status === 0) return "Can't reach the server. Check your connection and try again."
  if (status === 429) {
    return retryAfter
      ? `Too many attempts. Please wait ${retryAfter} seconds and try again.`
      : 'Too many attempts. Please wait a moment and try again.'
  }
  if (status >= 500) return 'Something went wrong on our side. Please try again.'
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>
    if (typeof record.detail === 'string') return record.detail
    for (const value of Object.values(record)) {
      const first = Array.isArray(value) ? value[0] : value
      if (typeof first === 'string') return first
    }
  }
  return `The request failed (${status}).`
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (!text) return undefined
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

async function toError(response: Response): Promise<ApiError> {
  const data = await readBody(response)
  const header = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
  const retryAfter = Number.isFinite(header) && header > 0 ? header : null
  return new ApiError(response.status, messageFor(response.status, data, retryAfter), data, retryAfter)
}

export interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
  /**
   * Send the access token and, on a 401, refresh and retry once. Set false for the sign-in, register and
   * refresh calls themselves: a 401 there means "wrong credentials", not "expired session".
   */
  auth?: boolean
}

export interface ApiClientOptions {
  baseUrl: string
  tokens: TokenStore
  fetchImpl?: typeof fetch
}

export function createApiClient({ baseUrl, tokens, fetchImpl }: ApiClientOptions) {
  const base = baseUrl.replace(/\/+$/, '')
  const sessionExpiredListeners = new Set<() => void>()
  let refreshInFlight: Promise<boolean> | null = null

  const send: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args)

  function url(path: string, query?: RequestOptions['query']): string {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value))
    }
    const search = params.toString()
    return `${base}${path}${search ? `?${search}` : ''}`
  }

  /** Ends the session: forget the tokens and tell the app (which shows the sign-in page). */
  function expireSession() {
    tokens.clear()
    sessionExpiredListeners.forEach((listener) => listener())
  }

  /**
   * Exchange the refresh token for a new access token. Single-flight: if several requests hit a 401 at
   * the same time they all wait on ONE refresh call, instead of each spending the refresh token.
   */
  function refreshAccessToken(): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight
    const refresh = tokens.get()?.refresh
    if (!refresh) return Promise.resolve(false)

    const attempt = (async () => {
      try {
        const response = await send(url('/api/auth/refresh/'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ refresh }),
        })
        if (!response.ok) return false
        const data = (await readBody(response)) as { access?: unknown; refresh?: unknown } | undefined
        if (typeof data?.access !== 'string') return false
        // The server may rotate the refresh token; if it does not, keep the one we have.
        tokens.set({ access: data.access, refresh: typeof data.refresh === 'string' ? data.refresh : refresh })
        return true
      } catch {
        return false
      }
    })()
    refreshInFlight = attempt
    void attempt.finally(() => {
      refreshInFlight = null
    })
    return attempt
  }

  async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { body, query, signal, auth = true } = options

    const attemptOnce = async (): Promise<Response> => {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const access = tokens.get()?.access
      if (auth && access) headers.Authorization = `Bearer ${access}`
      try {
        return await send(url(path, query), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw new ApiError(0, messageFor(0, undefined, null))
      }
    }

    let response = await attemptOnce()

    if (response.status === 401 && auth && tokens.get()) {
      if (!(await refreshAccessToken())) {
        expireSession()
        throw await toError(response)
      }
      response = await attemptOnce() // exactly one retry, now with the new access token
      if (response.status === 401) {
        expireSession() // a freshly issued token was refused: this session cannot be used
        throw await toError(response)
      }
    }

    if (!response.ok) throw await toError(response)
    return (await readBody(response)) as T
  }

  return {
    get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
    post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, { ...options, body }),
    patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PATCH', path, { ...options, body }),
    delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
    /** Called when the session can no longer be used (refresh failed). Returns an unsubscribe function. */
    onSessionExpired(listener: () => void): () => void {
      sessionExpiredListeners.add(listener)
      return () => sessionExpiredListeners.delete(listener)
    },
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

/** The app-wide instances. Tests build their own with createTokenStore / createApiClient. */
export const tokenStore = createTokenStore()
export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
  tokens: tokenStore,
})
