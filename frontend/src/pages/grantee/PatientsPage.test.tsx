import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import type { AccessiblePatient } from '../../api/types'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { PatientsPage } from './PatientsPage'

const render = () => renderWithProviders(<PatientsPage />, { auth: authValue(makeUser('doctor')) })
const patient = (id: number, overrides: Partial<AccessiblePatient> = {}): AccessiblePatient => ({
  id, email: `p${id}@example.com`, full_name: `Patient ${id}`, timezone: 'America/New_York', ...overrides,
})

describe('PatientsPage', () => {
  it('lists the patients who shared access, with their timezone', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([patient(1), patient(2, { full_name: '', timezone: 'Asia/Kolkata' })] as never)
    render()
    expect(await screen.findByText('Patient 1')).toBeInTheDocument()
    expect(screen.getByText('America/New York')).toBeInTheDocument()
    expect(screen.getByText('p2@example.com', { selector: 'p.font-display' })).toBeInTheDocument() // email stands in for a missing name
  })

  it('shows a loading state, an empty state and an error with retry', async () => {
    const spy = vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => undefined))
    const view = render()
    expect(screen.getByRole('status')).toHaveTextContent('Loading patients')
    view.unmount()

    spy.mockResolvedValue([] as never)
    renderWithProviders(<PatientsPage />, { auth: authValue(makeUser('caregiver')) })
    expect(await screen.findByRole('heading', { name: 'No patients yet' })).toBeInTheDocument()
  })

  it('offers a retry when loading fails', async () => {
    const spy = vi.spyOn(api, 'get').mockRejectedValue(new Error('down'))
    render()
    expect(await screen.findByText(/could not load your patients/i)).toBeInTheDocument()
    spy.mockResolvedValue([patient(7)] as never)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Patient 7')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([patient(1)] as never)
    const { container } = render()
    await screen.findByText('Patient 1')
    await expectNoA11yViolations(container)
  })
})
