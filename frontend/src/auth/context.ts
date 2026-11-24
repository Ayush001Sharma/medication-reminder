import { createContext, useContext } from 'react'
import type { Me, Role } from '../api/types'

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

export interface RegisterInput {
  email: string
  password: string
  fullName: string
  role: Role
  /** IANA timezone, required by the API for patients. */
  timezone?: string
}

export interface AuthValue {
  user: Me | null
  status: AuthStatus
  login(email: string, password: string): Promise<Me>
  register(input: RegisterInput): Promise<Me>
  logout(): void
}

export const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}

export const ROLE_LABEL: Record<Role, string> = {
  patient: 'Patient',
  caregiver: 'Caregiver',
  doctor: 'Doctor',
}

/** Where each role lands after signing in. */
export function homePathFor(role: Role): string {
  return role === 'patient' ? '/today' : '/patients'
}
