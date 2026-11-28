import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import type { Dose } from '../../api/types'
import { addDays, todayInZone } from '../../lib/dates'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { UpcomingPage } from './UpcomingPage'

const TZ = 'Asia/Kolkata'
let nextId = 1
const onDay = (date: string, time: string, overrides: Partial<Dose> = {}): Dose => ({
  id: nextId++,
  medication: { id: 1, name: 'Metformin', dosage: '500 mg', instructions: '' },
  scheduled_at: `${date}T${time}:00Z`,
  scheduled_local: `${date}T${time}:00+05:30`,
  status: 'pending',
  taken_late: false,
  taken_at: null,
  ...overrides,
})

const render = () => renderWithProviders(<UpcomingPage />, { auth: authValue(makeUser('patient')) })
const today = () => todayInZone(TZ)

describe('UpcomingPage', () => {
  it('asks for the next 7 days', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue([] as never)
    render()
    await screen.findByRole('heading', { name: /Nothing coming up/ })
    expect(get).toHaveBeenCalledWith('/api/doses/upcoming/', expect.objectContaining({ query: { days: 7 } }))
  })

  it('shows a loading skeleton first', () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => undefined))
    render()
    expect(screen.getByText('Loading upcoming doses…')).toBeInTheDocument()
  })

  it('groups doses by day with Today and Tomorrow labels, then dated headings, in order', async () => {
    const t = today()
    vi.spyOn(api, 'get').mockResolvedValue([
      onDay(addDays(t, 2), '09:00'), onDay(addDays(t, 1), '20:00'), onDay(t, '21:00'), onDay(addDays(t, 1), '08:00'), onDay(addDays(t, 5), '08:00'),
    ] as never)
    render()
    const headings = await screen.findAllByRole('heading', { level: 2 })
    expect(headings).toHaveLength(4)
    expect(headings[0]).toHaveTextContent('Today')
    expect(headings[1]).toHaveTextContent('Tomorrow')
    expect(headings[2]?.textContent).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{1,2} \w+$/)
    const tomorrow = screen.getByRole('region', { name: 'Tomorrow' })
    expect(within(tomorrow).getAllByRole('listitem').map((li) => li.textContent?.slice(0, 5))).toEqual(['08:00', '20:00'])
  })

  it('shows medication, dosage and status, and offers no action buttons (it is read-only)', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([onDay(today(), '21:00', { status: 'reminded' })] as never)
    render()
    expect(await screen.findByText('Metformin')).toBeInTheDocument()
    expect(screen.getByText('500 mg')).toBeInTheDocument()
    expect(screen.getByText('Reminder sent')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows an empty state that leads to adding a medication', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([] as never)
    render()
    expect(await screen.findByRole('heading', { name: 'Nothing coming up in the next 7 days' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add a medication' })).toHaveAttribute('href', '/medications/new')
  })

  it('shows an error with retry', async () => {
    const get = vi.spyOn(api, 'get').mockRejectedValue(new Error('down'))
    render()
    expect(await screen.findByText(/could not load your upcoming doses/i)).toBeInTheDocument()
    get.mockResolvedValue([onDay(today(), '21:00')] as never)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Metformin')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([onDay(today(), '21:00'), onDay(addDays(today(), 1), '08:00')] as never)
    const { container } = render()
    await screen.findAllByText('Metformin')
    await expectNoA11yViolations(container)
  })
})
