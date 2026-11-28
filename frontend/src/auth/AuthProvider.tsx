import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, tokenStore, type ApiClient } from '../api/client'
import type { TokenStore } from '../api/tokenStore'
import type { Me, TokenPair } from '../api/types'
import { useToast } from '../toast/context'
import { AuthContext, type AuthStatus, type AuthValue, type RegisterInput } from './context'

interface AuthProviderProps {
  children: ReactNode
  /** Injectable for tests; the app uses the shared instances. */
  client?: ApiClient
  tokens?: TokenStore
}

export function AuthProvider({ children, client = api, tokens = tokenStore }: AuthProviderProps) {
  const toast = useToast()
  const [user, setUser] = useState<Me | null>(null)
  // A saved session means we must ask the server who we are before deciding what to show.
  const [status, setStatus] = useState<AuthStatus>(() => (tokens.get() ? 'loading' : 'anonymous'))

  useEffect(() => {
    if (!tokens.get()) return
    let active = true
    client
      .get<Me>('/api/me/')
      .then((me) => {
        if (!active) return
        setUser(me)
        setStatus('authenticated')
      })
      .catch(() => {
        // A 401 has already cleared the tokens (and fired onSessionExpired). Any other failure, for
        // example the server being down, leaves the saved session alone so a reload can recover.
        if (!active) return
        setUser(null)
        setStatus('anonymous')
      })
    return () => {
      active = false
    }
  }, [client, tokens])

  useEffect(
    () =>
      client.onSessionExpired(() => {
        setUser(null)
        setStatus('anonymous')
        toast.info('Your session ended. Please sign in again.')
      }),
    [client, toast],
  )

  const login = useCallback(
    async (email: string, password: string) => {
      const pair = await client.post<TokenPair>('/api/auth/login/', { email, password }, { auth: false })
      tokens.set(pair)
      try {
        const me = await client.get<Me>('/api/me/')
        setUser(me)
        setStatus('authenticated')
        return me
      } catch (error) {
        tokens.clear()
        throw error
      }
    },
    [client, tokens],
  )

  const register = useCallback(
    async (input: RegisterInput) => {
      await client.post(
        '/api/auth/register/',
        {
          email: input.email,
          password: input.password,
          full_name: input.fullName,
          role: input.role,
          ...(input.role === 'patient' ? { timezone: input.timezone } : {}),
        },
        { auth: false },
      )
      return login(input.email, input.password)
    },
    [client, login],
  )

  const logout = useCallback(() => {
    tokens.clear()
    setUser(null)
    setStatus('anonymous')
  }, [tokens])

  const value = useMemo<AuthValue>(
    () => ({ user, status, login, register, logout }),
    [user, status, login, register, logout],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
