/**
 * Where the JWTs live: in memory, mirrored to sessionStorage so a page reload keeps you signed in for the
 * life of the browser tab. NEVER localStorage: it survives the browser being closed and is shared by every
 * tab, which is a much longer exposure for a bearer credential. (sessionStorage is still readable by any
 * script running on the page, so XSS remains the real threat: this app renders no untrusted HTML.)
 */
export interface Tokens {
  access: string
  refresh: string
}

const STORAGE_KEY = 'medreminder.session'

function isTokens(value: unknown): value is Tokens {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.access === 'string' && typeof candidate.refresh === 'string'
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null // storage can throw (private mode, blocked cookies): carry on in memory only
  }
}

export function createTokenStore(storage: Storage | null = defaultStorage()) {
  const listeners = new Set<() => void>()

  function load(): Tokens | null {
    try {
      const raw = storage?.getItem(STORAGE_KEY)
      if (!raw) return null
      const parsed: unknown = JSON.parse(raw)
      return isTokens(parsed) ? parsed : null
    } catch {
      return null // corrupt or unavailable: start signed out
    }
  }

  let tokens: Tokens | null = load()

  function persist() {
    try {
      if (tokens) storage?.setItem(STORAGE_KEY, JSON.stringify(tokens))
      else storage?.removeItem(STORAGE_KEY)
    } catch {
      /* memory still holds the tokens */
    }
  }

  function notify() {
    listeners.forEach((listener) => listener())
  }

  return {
    get: (): Tokens | null => tokens,
    set(next: Tokens) {
      tokens = { access: next.access, refresh: next.refresh }
      persist()
      notify()
    },
    clear() {
      tokens = null
      persist()
      notify()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type TokenStore = ReturnType<typeof createTokenStore>
