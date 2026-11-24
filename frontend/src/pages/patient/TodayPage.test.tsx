import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import type { AdherenceReport, Dose } from '../../api/types'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { TodayPage } from './TodayPage'

const dose = (id: number, overrides: Partial<Dose> = {}): Dose => ({
  id,
  medication: { id: 1, name: 'Metformin', dosage: '500 mg', instructions: '' },
  scheduled_at: '2026-11-25T02:30:00Z',
  scheduled_local: '2026-11-25T08:00:00+05:30',
  status: 'pending',
  taken_late: false,
  taken_at: null,
  ...overrides,
})

const report: AdherenceReport = {
  totals: { total: 24, taken: 21, taken_late: 1, missed: 1, skipped: 2, adherence_percent: 95.5 },
  current_streak: 14,
  range: { from: '2026-10-26', to: '2026-11-24', timezone: 'Asia/Kolkata' },
}

function mockApi(doses: Dose[] | Error | Promise<Dose[]>, rep: AdherenceReport | Error = report) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    const value = path.includes('/doses/today/') ? await doses : rep
    if (value instanceof Error) throw value
    return value as never
  })
}

const render = () => renderWithProviders(<TodayPage />, { auth: authValue(makeUser('patient')) })

describe('TodayPage', () => {
  it('shows a loading state first', () => {
    mockApi(new Promise<Dose[]>(() => undefined))
    render()
    expect(screen.getAllByRole('status').map((n) => n.textContent).join(' ')).toContain("Loading today's doses")
  })

  it("lists today's doses with local time, medication, dosage and status", async () => {
    mockApi([
      dose(1),
      dose(2, { medication: { id: 2, name: 'Atorvastatin', dosage: '20 mg', instructions: '' }, scheduled_local: '2026-11-25T21:00:00+05:30', status: 'taken' }),
      dose(3, { status: 'taken', taken_late: true }),
      dose(4, { status: 'missed' }),
    ])
    render()
    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(4)
    expect(within(items[0] as HTMLElement).getByText('08:00')).toBeInTheDocument()
    expect(within(items[0] as HTMLElement).getByText('Metformin')).toBeInTheDocument()
    expect(within(items[0] as HTMLElement).getByText('500 mg')).toBeInTheDocument()
    expect(within(items[0] as HTMLElement).getByText('Upcoming')).toBeInTheDocument()
    expect(within(items[1] as HTMLElement).getByText('21:00')).toBeInTheDocument()
    expect(within(items[1] as HTMLElement).getByText('Taken')).toBeInTheDocument()
    expect(within(items[2] as HTMLElement).getByText('Taken late')).toBeInTheDocument()
    expect(within(items[3] as HTMLElement).getByText('Missed')).toBeInTheDocument()
  })

  it('greets the user by first name', async () => {
    mockApi([])
    render()
    expect(screen.getByRole('heading', { level: 1, name: 'Hello, Asha' })).toBeInTheDocument()
    await screen.findByText('No doses today')
  })

  it('shows the 30-day adherence as a chart with a text alternative, plus counts and streak', async () => {
    mockApi([dose(1)])
    render()
    expect(await screen.findByRole('img', { name: 'Adherence 96 percent' })).toBeInTheDocument()
    expect(screen.getByText('21 taken · 1 missed · 2 skipped')).toBeInTheDocument()
    expect(screen.getByText('Current streak: 14 doses in a row')).toBeInTheDocument()
  })

  it('shows an empty state when nothing is scheduled today', async () => {
    mockApi([])
    render()
    expect(await screen.findByRole('heading', { name: 'No doses today' })).toBeInTheDocument()
  })

  it('shows an error with a retry that loads again', async () => {
    const spy = mockApi(new Error('boom'), new Error('boom'))
    render()
    expect(await screen.findByText(/could not load today's doses/i)).toBeInTheDocument()
    spy.mockImplementation(async (path: string) => (path.includes('/doses/today/') ? [dose(1)] : report) as never)
    await userEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0] as HTMLElement)
    expect(await screen.findByText('Metformin')).toBeInTheDocument()
  })

  it('still shows the doses when only the adherence report fails', async () => {
    mockApi([dose(1)], new Error('report down'))
    render()
    expect(await screen.findByText('Metformin')).toBeInTheDocument()
    expect(await screen.findByText(/could not load your adherence/i)).toBeInTheDocument()
  })

  it('has no accessibility violations once loaded', async () => {
    mockApi([dose(1), dose(2, { status: 'missed' })])
    const { container } = render()
    await screen.findByRole('img', { name: /adherence/i })
    await expectNoA11yViolations(container)
  })
})
