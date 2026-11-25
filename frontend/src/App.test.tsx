import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { api } from './api/client'
import type { Role } from './api/types'
import { authValue, makeUser, renderWithProviders } from './test/helpers'

function visit(route: string, role: Role | null, status?: 'loading') {
  vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => undefined)) // pages stay in their loading state
  return renderWithProviders(<App />, { route, auth: authValue(role ? makeUser(role) : null, {}, status) })
}

describe('the front door', () => {
  it('shows the landing page to a visitor at "/"', () => {
    visit('/', null)
    expect(screen.getByRole('heading', { level: 1, name: /Gentle reminders/ })).toBeInTheDocument()
  })

  it.each([
    ['patient', 'Today'],
    ['caregiver', 'Patients'],
    ['doctor', 'Patients'],
  ] as const)('sends a signed-in %s from "/" to %s', (role, heading) => {
    visit('/', role)
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
    expect(screen.queryByText(/Gentle reminders/)).not.toBeInTheDocument()
  })

  it('shows nothing (rather than a flash of the landing page) while the account is being checked', () => {
    visit('/', null, 'loading')
    expect(screen.queryByText(/Gentle reminders/)).not.toBeInTheDocument()
  })
})

describe('page not found', () => {
  it('gives a visitor a plain page with a way back, not a sign-in redirect', () => {
    visit('/no/such/page', null)
    expect(screen.getByRole('heading', { level: 1, name: 'We could not find that page' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the start page' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument()
    expect(document.title).toBe('Page not found · MedReminder')
  })

  it.each([
    ['patient', '/today'],
    ['caregiver', '/patients'],
  ] as const)('keeps a signed-in %s inside the app shell, with a link home', (role, home) => {
    visit('/definitely/not/here', role)
    expect(screen.getByRole('heading', { level: 1, name: 'We could not find that page' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to my home page' })).toHaveAttribute('href', home)
  })

  it('treats a near miss of a real route the same way', () => {
    visit('/medications/new/extra', 'patient')
    expect(screen.getByRole('heading', { level: 1, name: 'We could not find that page' })).toBeInTheDocument()
  })
})

describe('page titles', () => {
  it.each([
    ['/login', null, 'Sign in · MedReminder'],
    ['/register', null, 'Create account · MedReminder'],
    ['/today', 'patient', 'Today · MedReminder'],
    ['/upcoming', 'patient', 'Upcoming · MedReminder'],
    ['/medications', 'patient', 'Medications · MedReminder'],
    ['/medications/new', 'patient', 'Add medication · MedReminder'],
    ['/medications/3/edit', 'patient', 'Edit medication · MedReminder'],
    ['/sharing', 'patient', 'Sharing · MedReminder'],
    ['/activity', 'patient', 'Activity · MedReminder'],
    ['/patients', 'doctor', 'Patients · MedReminder'],
    ['/invitations', 'caregiver', 'Invitations · MedReminder'],
    ['/patients/5', 'doctor', 'Adherence report · MedReminder'],
    ['/patients', 'patient', 'Not available · MedReminder'],
  ] as const)('%s as %s is titled "%s"', (route, role, title) => {
    visit(route, role)
    expect(document.title).toBe(title)
  })
})
