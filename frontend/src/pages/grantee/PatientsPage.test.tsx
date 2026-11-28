import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../../api/client'
import type { AccessiblePatient, Invitation } from '../../api/types'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { InvitationsPage } from './InvitationsPage'
import { PatientsPage } from './PatientsPage'

const patient = (id: number, overrides: Partial<AccessiblePatient> = {}): AccessiblePatient => ({
  id, email: `p${id}@example.com`, full_name: `Patient ${id}`, timezone: 'America/New_York', ...overrides,
})
const invitation = (id: number, name = `Inviter ${id}`): Invitation => ({
  id, patient: { id: 100 + id, email: `inviter${id}@example.com`, full_name: name, role: 'patient' }, status: 'pending', created_at: '2026-11-24T10:00:00Z', accepted_at: null,
})

/** Answer each endpoint separately: the page loads patients and invitations independently. */
function serve(data: { patients?: AccessiblePatient[] | Error | 'never'; invitations?: Invitation[] | Error | 'never' }) {
  const answer = (value: unknown) => (value === 'never' ? new Promise(() => undefined) : value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []))
  return vi.spyOn(api, 'get').mockImplementation((path: string) => (path === '/api/patients/' ? answer(data.patients) : answer(data.invitations)) as never)
}
const render = (role: 'doctor' | 'caregiver' = 'doctor') => renderWithProviders(<PatientsPage />, { auth: authValue(makeUser(role)) })

afterEach(() => vi.restoreAllMocks())

describe('PatientsPage: patients', () => {
  it('lists the patients who shared access, with their timezone and a link to the report', async () => {
    serve({ patients: [patient(1), patient(2, { full_name: '', timezone: 'Asia/Kolkata' })] })
    render()
    expect(await screen.findByText('Patient 1')).toBeInTheDocument()
    expect(screen.getByText('America/New York')).toBeInTheDocument()
    expect(screen.getByText('p2@example.com', { selector: 'p.font-display' })).toBeInTheDocument() // email stands in for a missing name
    expect(screen.getByRole('link', { name: 'View adherence report for Patient 1' })).toHaveAttribute('href', '/patients/1')
    expect(screen.getByRole('link', { name: 'View adherence report for p2@example.com' })).toHaveAttribute('href', '/patients/2')
  })

  it('shows a loading state and a clear empty state', async () => {
    const spy = serve({ patients: 'never' })
    const view = render()
    expect(screen.getByText('Loading patients…')).toBeInTheDocument()
    view.unmount()

    spy.mockRestore()
    serve({ patients: [] })
    render('caregiver')
    expect(await screen.findByRole('heading', { name: 'No patients yet' })).toBeInTheDocument()
    expect(screen.getByText(/they will appear here/i)).toBeInTheDocument()
  })

  it('offers a retry when loading fails', async () => {
    const spy = serve({ patients: new Error('down') })
    render()
    expect(await screen.findByText(/could not load your patients/i)).toBeInTheDocument()
    spy.mockRestore()
    serve({ patients: [patient(7)] })
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Patient 7')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    serve({ patients: [patient(1)], invitations: [invitation(1)] })
    const { container } = render()
    await screen.findByText('Patient 1')
    await screen.findByText('Inviter 1')
    await expectNoA11yViolations(container)
  })
})

describe('PatientsPage: pending invitations', () => {
  it('shows an invitations area, with a calm message when there are none', async () => {
    serve({ patients: [patient(1)], invitations: [] })
    render()
    expect(await screen.findByText('No pending invitations.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Pending invitations' })).toBeInTheDocument()
  })

  it('lists who invited you, with an Accept button each', async () => {
    serve({ invitations: [invitation(1, 'Priya Nair'), invitation(2)] })
    render()
    expect(await screen.findByText('Priya Nair')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept invitation from Priya Nair' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Accept invitation from Inviter 2' })).toBeEnabled()
    expect(screen.getAllByText(/invited 24 Nov 2026/)).toHaveLength(2)
  })

  it('accepting posts to the API, confirms, removes the invitation and refreshes the patient list', async () => {
    const spy = serve({ patients: [], invitations: [invitation(5, 'Priya Nair')] })
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never)
    render()
    await screen.findByText('Priya Nair')
    spy.mockImplementation((path: string) => Promise.resolve(path === '/api/patients/' ? [patient(105, { full_name: 'Priya Nair' })] : []) as never)

    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation from Priya Nair' }))

    expect(post).toHaveBeenCalledWith('/api/access/invitations/5/accept/')
    expect(await screen.findByText("You can now see Priya Nair's adherence reports.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Accept invitation/ })).not.toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'View adherence report for Priya Nair' })).toBeInTheDocument()
  })

  it('blocks a second click while an accept is in flight', async () => {
    serve({ invitations: [invitation(5, 'Priya Nair'), invitation(6, 'Sam Lee')] })
    let finish: (value: unknown) => void = () => undefined
    const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    render()
    const accept = await screen.findByRole('button', { name: 'Accept invitation from Priya Nair' })
    await userEvent.click(accept)
    expect(accept).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Accept invitation from Sam Lee' })).toBeDisabled()
    await userEvent.click(accept)
    expect(post).toHaveBeenCalledTimes(1)
    finish({})
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept invitation from Priya Nair' })).not.toBeInTheDocument())
  })

  it('explains calmly when the patient withdrew the invitation first (404)', async () => {
    serve({ invitations: [invitation(5, 'Priya Nair')] })
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(404, 'Not found.'))
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation from Priya Nair' }))
    expect(await screen.findByText(/invitation from Priya Nair is no longer available/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Accept invitation/ })).not.toBeInTheDocument()
  })

  it('keeps the invitation and says what went wrong on another failure', async () => {
    serve({ invitations: [invitation(5, 'Priya Nair')] })
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(500, 'Something went wrong on our side. Please try again.'))
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation from Priya Nair' }))
    expect(await screen.findByText('Something went wrong on our side. Please try again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept invitation from Priya Nair' })).toBeEnabled()
  })

  it('fails on its own: a broken invitations list does not hide the patients', async () => {
    serve({ patients: [patient(1)], invitations: new Error('down') })
    render()
    expect(await screen.findByText('Patient 1')).toBeInTheDocument()
    expect(await screen.findByText(/could not load your invitations/i)).toBeInTheDocument()
  })
})

describe('InvitationsPage', () => {
  it('is the same invitations area on its own page', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([invitation(1, 'Priya Nair')] as never)
    renderWithProviders(<InvitationsPage />, { auth: authValue(makeUser('caregiver')) })
    expect(screen.getByRole('heading', { level: 1, name: 'Invitations' })).toBeInTheDocument()
    const region = await screen.findByRole('region', { name: 'Pending invitations' })
    expect(within(region).getByRole('button', { name: 'Accept invitation from Priya Nair' })).toBeInTheDocument()
  })
})
