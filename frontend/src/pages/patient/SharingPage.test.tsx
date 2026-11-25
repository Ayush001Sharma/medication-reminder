import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../../api/client'
import type { Grant } from '../../api/types'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { SharingPage } from './SharingPage'

const NEUTRAL = 'Invitation recorded. Access starts only if that person accepts it from a caregiver or doctor account registered with this email.'

const active = (id: number, name: string, role: 'doctor' | 'caregiver' = 'doctor'): Grant => ({
  id, invited_email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, status: 'active',
  grantee: { id: 200 + id, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, full_name: name, role },
  created_at: '2026-11-01T08:00:00Z', accepted_at: '2026-11-02T20:00:00Z', revoked_at: null,
})
const pending = (id: number, email: string): Grant => ({
  id, invited_email: email, status: 'pending', grantee: null, created_at: '2026-11-20T08:00:00Z', accepted_at: null, revoked_at: null,
})
const revoked = (id: number): Grant => ({ ...active(id, 'Gone Person'), status: 'revoked', revoked_at: '2026-11-10T08:00:00Z' })

const render = () => renderWithProviders(<SharingPage />, { auth: authValue(makeUser('patient')) })
const type = async (value: string) => userEvent.type(screen.getByLabelText('Their email address'), value)
const send = () => userEvent.click(screen.getByRole('button', { name: 'Send invitation' }))

afterEach(() => vi.restoreAllMocks())

describe('SharingPage: who has access', () => {
  it('lists people with access and pending invitations, and hides revoked ones', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([active(1, 'Dr Rao'), pending(2, 'new@example.com'), revoked(3)] as never)
    render()
    const people = within(await screen.findByRole('region', { name: 'People with access' }))
    expect(people.getByText('Dr Rao')).toBeInTheDocument()
    expect(people.getByText('Doctor')).toBeInTheDocument()
    expect(people.getByText(/dr\.rao@example\.com · since 3 Nov 2026/)).toBeInTheDocument() // 20:00 UTC is already the 3rd in Kolkata
    const waiting = within(screen.getByRole('region', { name: 'Pending invitations' }))
    expect(waiting.getByText('new@example.com')).toBeInTheDocument()
    expect(waiting.getByText(/Invited 20 Nov 2026/)).toBeInTheDocument()
    expect(screen.queryByText('Gone Person')).not.toBeInTheDocument()
  })

  it('shows calm empty states for both lists', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([] as never)
    render()
    expect(await screen.findByText('Nobody can see your reports yet. You decide who does.')).toBeInTheDocument()
    expect(screen.getByText('No invitations waiting.')).toBeInTheDocument()
  })

  it('shows a loading state, and an error with retry', async () => {
    const spy = vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => undefined))
    const view = render()
    expect(screen.getByText('Loading who has access…')).toBeInTheDocument()
    expect(screen.getByLabelText('Their email address')).toBeInTheDocument() // the invite form works while the lists load
    view.unmount()

    spy.mockRejectedValue(new Error('down'))
    render()
    expect(await screen.findByText(/could not load who has access/i)).toBeInTheDocument()
    spy.mockResolvedValue([active(1, 'Dr Rao')] as never)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Dr Rao')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([active(1, 'Dr Rao'), pending(2, 'new@example.com')] as never)
    const { container } = render()
    await screen.findByText('Dr Rao')
    await expectNoA11yViolations(container)
  })
})

describe('SharingPage: inviting', () => {
  it('posts the email and shows the neutral confirmation, clears the field and refreshes the lists', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue([] as never)
    const post = vi.spyOn(api, 'post').mockResolvedValue({ detail: NEUTRAL } as never)
    render()
    await screen.findByText('No invitations waiting.')
    get.mockResolvedValue([pending(1, 'new@example.com')] as never)

    await type('  new@example.com ')
    await send()

    expect(post).toHaveBeenCalledWith('/api/access/grants/', { email: 'new@example.com' })
    expect(await screen.findByRole('status')).toHaveTextContent(NEUTRAL)
    expect(screen.getByLabelText('Their email address')).toHaveValue('')
    expect(await screen.findByText('Cancel invitation')).toBeInTheDocument()
  })

  it('shows exactly the same confirmation whatever the email, so it never reveals whether an account exists', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([] as never)
    vi.spyOn(api, 'post').mockResolvedValue({ detail: NEUTRAL } as never)
    render()
    await screen.findByText('No invitations waiting.')
    const shown: string[] = []
    for (const address of ['registered.doctor@example.com', 'nobody.here@example.org', 'someone@elsewhere.net']) {
      await type(address)
      await send()
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(NEUTRAL))
      shown.push(screen.getByRole('status').textContent ?? '')
    }
    expect(new Set(shown)).toEqual(new Set([NEUTRAL]))
  })

  it('falls back to the same neutral sentence if the API sends no text', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([] as never)
    vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    render()
    await screen.findByText('No invitations waiting.')
    await type('a@example.com')
    await send()
    expect(await screen.findByRole('status')).toHaveTextContent(NEUTRAL)
  })

  it('checks the email before sending anything', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([] as never)
    const post = vi.spyOn(api, 'post')
    render()
    await send()
    expect(await screen.findByText('Enter their email address.')).toBeInTheDocument()
    await type('not-an-email')
    await send()
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument()
    expect(screen.getByLabelText('Their email address')).toBeInvalid()
    expect(post).not.toHaveBeenCalled()
  })

  it('shows the API field error under the field (for example inviting yourself)', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([] as never)
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(400, 'You cannot invite yourself.', { email: ['You cannot invite yourself.'] }))
    render()
    await type('patient@example.com')
    await send()
    expect(await screen.findByText('You cannot invite yourself.')).toBeInTheDocument()
    expect(screen.getByLabelText('Their email address')).toBeInvalid()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Their email address')).toHaveValue('patient@example.com') // not lost
  })

  it('shows a rate-limit message as an alert and keeps the typed email', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([] as never)
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(429, 'Too many attempts. Please wait 30 seconds and try again.', undefined, 30))
    render()
    await type('a@example.com')
    await send()
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Please wait 30 seconds and try again.')
    expect(screen.getByLabelText('Their email address')).toHaveValue('a@example.com')
  })
})

describe('SharingPage: revoking', () => {
  it('asks first, and keeping it changes nothing', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([active(1, 'Dr Rao')] as never)
    const post = vi.spyOn(api, 'post')
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke access for Dr Rao' }))
    const dialog = screen.getByRole('dialog', { name: 'Revoke access for Dr Rao?' })
    expect(within(dialog).getByText(/will not be able to see your reports from now on/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByText('Dr Rao')).toBeInTheDocument()
  })

  it('revokes on confirmation, removes the person at once and confirms', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue([active(1, 'Dr Rao'), active(2, 'Carla Mendes', 'caregiver')] as never)
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never)
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke access for Dr Rao' }))
    get.mockResolvedValue([active(2, 'Carla Mendes', 'caregiver')] as never)
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke access' }))

    expect(post).toHaveBeenCalledWith('/api/access/grants/1/revoke/')
    expect(await screen.findByText('Dr Rao can no longer see your reports.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke access for Dr Rao' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revoke access for Carla Mendes' })).toBeInTheDocument()
  })

  it('cancels a pending invitation the same way, with its own wording', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([pending(4, 'new@example.com')] as never)
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never)
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel invitation to new@example.com' }))
    const dialog = screen.getByRole('dialog', { name: 'Cancel this invitation?' })
    expect(within(dialog).getByText('new@example.com will no longer be able to accept.')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel invitation' }))
    expect(post).toHaveBeenCalledWith('/api/access/grants/4/revoke/')
    expect(await screen.findByText('Invitation cancelled.')).toBeInTheDocument()
  })

  it('keeps the dialog open and explains when revoking fails', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([active(1, 'Dr Rao')] as never)
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(500, 'Something went wrong on our side. Please try again.'))
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke access for Dr Rao' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke access' }))
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Something went wrong on our side')
    expect(screen.getByText('Dr Rao')).toBeInTheDocument()
  })

  it('treats a 404 (already removed elsewhere) as done, without an error', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([active(1, 'Dr Rao')] as never)
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(404, 'Not found.'))
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke access for Dr Rao' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke access' }))
    expect(await screen.findByText(/already gone/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('SharingPage: keyboard focus on errors', () => {
  it('moves focus to the email field when it is invalid', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([] as never)
    render()
    await send()
    expect(await screen.findByText('Enter their email address.')).toBeInTheDocument()
    expect(screen.getByLabelText('Their email address')).toHaveFocus()
  })
})
