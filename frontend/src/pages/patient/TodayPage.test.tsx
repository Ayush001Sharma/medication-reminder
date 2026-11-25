import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../../api/client'
import type { AdherenceReport, Dose, DoseStatus } from '../../api/types'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { TodayPage } from './TodayPage'

let nextId = 1
const dose = (time: string, status: DoseStatus = 'pending', overrides: Partial<Dose> = {}): Dose => ({
  id: nextId++,
  medication: { id: 1, name: 'Metformin', dosage: '500 mg', instructions: '' },
  scheduled_at: `2026-11-25T${time}:00Z`,
  scheduled_local: `2026-11-25T${time}:00+05:30`,
  status,
  taken_late: false,
  taken_at: status === 'taken' ? '2026-11-25T03:00:00Z' : null,
  ...overrides,
})

const report: AdherenceReport = {
  totals: { total: 24, taken: 21, taken_late: 1, missed: 1, skipped: 2, adherence_percent: 95.5 },
  current_streak: 14,
  range: { from: '2026-10-26', to: '2026-11-24', timezone: 'Asia/Kolkata' },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(initial: Dose[] | Promise<Dose[]> | Error) {
  let today: Dose[] | Promise<Dose[]> | Error = initial
  const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (!path.includes('/doses/today/')) return report as never
    const value = await today
    if (value instanceof Error) throw value
    return value as never
  })
  const post = vi.spyOn(api, 'post')
  renderWithProviders(<TodayPage />, { auth: authValue(makeUser('patient')) })
  return { get, post, serve: (next: Dose[] | Promise<Dose[]> | Error) => (today = next) }
}

const takenButton = (time: string) => screen.getByRole('button', { name: new RegExp(`^Taken: .* at ${time}$`) })
const skipButton = (time: string) => screen.getByRole('button', { name: new RegExp(`^Skip: .* at ${time}$`) })

describe('Today page: showing the doses', () => {
  it('shows a loading skeleton first', () => {
    setup(new Promise<Dose[]>(() => undefined))
    expect(screen.getByText("Loading today's doses…")).toBeInTheDocument()
  })

  it('groups doses by time of day, in order, each in time order, with the local time', async () => {
    setup([dose('22:00'), dose('13:00'), dose('08:30'), dose('19:00'), dose('07:00')])
    const morning = await screen.findByRole('region', { name: /morning/i })
    const groups = screen.getAllByRole('region').map((r) => r.getAttribute('aria-labelledby')).filter((id) => id?.startsWith('part-'))
    expect(groups).toEqual(['part-morning', 'part-afternoon', 'part-evening', 'part-night'])
    expect(within(morning).getAllByRole('listitem').map((li) => li.textContent?.slice(0, 5))).toEqual(['07:00', '08:30'])
    expect(within(screen.getByRole('region', { name: /night/i })).getByText('22:00')).toBeInTheDocument()
  })

  it('shows medication, dosage, instructions and the right status chip for every status', async () => {
    setup([
      dose('06:00', 'pending'),
      dose('07:00', 'reminded', { medication: { id: 2, name: 'Atorvastatin', dosage: '20 mg', instructions: 'At bedtime' } }),
      dose('08:00', 'taken'),
      dose('09:00', 'taken', { taken_late: true, taken_at: '2026-11-25T05:00:00Z' }),
      dose('10:00', 'missed'),
      dose('11:00', 'skipped'),
    ])
    await screen.findByText('Atorvastatin')
    for (const label of ['Upcoming', 'Reminder sent', 'Taken', 'Taken late', 'Missed', 'Skipped']) expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    expect(screen.getByText('20 mg · At bedtime')).toBeInTheDocument()
    expect(screen.getByText('Taken at 08:30')).toBeInTheDocument() // 03:00Z in Asia/Kolkata
    expect(screen.getByText('Taken at 10:30')).toBeInTheDocument() // 05:00Z
  })

  it("summarises progress in the header: '2 of 4 taken'", async () => {
    setup([dose('08:00', 'taken'), dose('12:00', 'taken'), dose('18:00'), dose('21:00', 'missed')])
    expect(await screen.findByText(/2 of 4 taken/)).toBeInTheDocument()
  })

  it('offers only the actions the API allows for each status', async () => {
    setup([dose('06:00', 'pending'), dose('07:00', 'reminded'), dose('08:00', 'missed'), dose('09:00', 'taken'), dose('10:00', 'skipped')])
    await screen.findByText('Skipped')
    for (const time of ['06:00', '07:00']) {
      expect(takenButton(time)).toBeInTheDocument()
      expect(skipButton(time)).toBeInTheDocument()
    }
    expect(takenButton('08:00')).toBeInTheDocument() // a missed dose can be taken late...
    expect(screen.queryByRole('button', { name: /^Skip: .* at 08:00$/ })).not.toBeInTheDocument() // ...but not skipped
    for (const time of ['09:00', '10:00']) expect(screen.queryByRole('button', { name: new RegExp(`at ${time}$`) })).not.toBeInTheDocument() // final
  })

  it('shows a calm empty state with a way forward', async () => {
    setup([])
    expect(await screen.findByRole('heading', { name: 'Nothing scheduled today' })).toBeInTheDocument()
    expect(screen.getByText(/A quiet day/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See my medications' })).toHaveAttribute('href', '/medications')
  })

  it('shows an error with a retry that loads again', async () => {
    const { serve } = setup(new Error('boom'))
    expect(await screen.findByText(/could not load today's doses/i)).toBeInTheDocument()
    serve([dose('08:00')])
    await userEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0] as HTMLElement)
    expect(await screen.findByText('Metformin')).toBeInTheDocument()
  })
})

describe('Today page: Taken and Skip', () => {
  it('Taken updates the screen IMMEDIATELY, before the server answers, then confirms with a toast', async () => {
    const original = dose('08:00', 'reminded')
    const { post } = setup([original])
    const request = deferred<Dose>()
    post.mockReturnValue(request.promise as never)
    await screen.findByText('Reminder sent')

    await userEvent.click(takenButton('08:00'))

    // the request has not been answered yet, and the screen already shows the result
    expect(post).toHaveBeenCalledWith(`/api/doses/${original.id}/taken/`)
    expect(screen.getByText('Taken')).toBeInTheDocument()
    expect(screen.queryByText('Reminder sent')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Taken: / })).not.toBeInTheDocument()
    expect(screen.getByText(/1 of 1 taken/)).toBeInTheDocument()

    request.resolve({ ...original, status: 'taken', taken_at: '2026-11-25T03:00:00Z' })
    expect(await screen.findByText('Marked Metformin as taken.')).toBeInTheDocument()
  })

  it('Skip works the same way', async () => {
    const original = dose('08:00', 'pending')
    const { post } = setup([original])
    const request = deferred<Dose>()
    post.mockReturnValue(request.promise as never)
    await screen.findByText('Upcoming')
    await userEvent.click(skipButton('08:00'))
    expect(post).toHaveBeenCalledWith(`/api/doses/${original.id}/skip/`)
    expect(screen.getByText('Skipped')).toBeInTheDocument()
    request.resolve({ ...original, status: 'skipped' })
    expect(await screen.findByText('Skipped Metformin.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Skip: / })).not.toBeInTheDocument()
  })

  it('a missed dose taken now becomes "Taken late" and the toast says so', async () => {
    const { post } = setup([dose('08:00', 'missed')])
    post.mockResolvedValue(dose('08:00', 'taken', { id: 3, taken_late: true }) as never)
    await screen.findByText('Missed')
    await userEvent.click(takenButton('08:00'))
    expect(await screen.findByText('Recorded Metformin as taken late.')).toBeInTheDocument()
    expect(screen.getByText('Taken late')).toBeInTheDocument()
  })

  it('ignores a second click while the first request is still travelling', async () => {
    const { post } = setup([dose('08:00')])
    post.mockReturnValue(deferred<Dose>().promise as never)
    await screen.findByText('Upcoming')
    const button = takenButton('08:00')
    await userEvent.dblClick(button)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('disables a dose\'s buttons while its request is in flight', async () => {
    const { post } = setup([dose('08:00'), dose('20:00')])
    post.mockReturnValue(deferred<Dose>().promise as never)
    await screen.findAllByText('Upcoming')
    await userEvent.click(skipButton('08:00'))
    expect(screen.getByText('08:00').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true')
    // the other dose is unaffected
    expect(takenButton('20:00')).toBeEnabled()
  })

  it('a network failure undoes the change and offers "Try again", which retries', async () => {
    const { post } = setup([dose('08:00', 'reminded')])
    post.mockRejectedValueOnce(new ApiError(0, "Can't reach the server. Check your connection and try again."))
    await screen.findByText('Reminder sent')

    await userEvent.click(takenButton('08:00'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Metformin was not updated. Can't reach the server")
    expect(screen.getByText('Reminder sent')).toBeInTheDocument() // rolled back
    expect(takenButton('08:00')).toBeEnabled() // and can be tried again by hand

    post.mockResolvedValueOnce(dose('08:00', 'taken', { id: 5 }) as never)
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Marked Metformin as taken.')).toBeInTheDocument()
    expect(post).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a server error is shown and rolled back too', async () => {
    const { post } = setup([dose('08:00')])
    post.mockRejectedValue(new ApiError(500, 'Something went wrong on our side. Please try again.'))
    await screen.findByText('Upcoming')
    await userEvent.click(skipButton('08:00'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side')
    expect(screen.getByText('Upcoming')).toBeInTheDocument()
  })
})

describe('Today page: 409 conflicts', () => {
  it('explains it in plain language, refreshes from the server, and keeps the list on screen while doing so', async () => {
    const { post, get, serve } = setup([dose('08:00', 'reminded')])
    await screen.findByText('Reminder sent')
    // meanwhile, on another device, the dose was taken
    const refreshed = deferred<Dose[]>()
    serve(refreshed.promise)
    post.mockRejectedValue(new ApiError(409, 'A taken dose cannot be marked skipped.', { detail: 'A taken dose cannot be marked skipped.' }))

    await userEvent.click(skipButton('08:00'))

    expect(await screen.findByText("That dose is already marked as taken, so it can't be skipped. We've refreshed the list.")).toBeInTheDocument()
    await waitFor(() => expect(get.mock.calls.filter(([path]) => String(path).includes('/doses/today/'))).toHaveLength(2))
    expect(screen.queryByText("Loading today's doses…")).not.toBeInTheDocument() // no skeleton flash: the list stays put
    expect(screen.getByText('Metformin')).toBeInTheDocument()

    refreshed.resolve([dose('08:00', 'taken', { id: 6 })])
    expect(await screen.findByText(/1 of 1 taken/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Skip: / })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument() // a conflict is information, not an error alert
  })

  it('also handles "skipped dose cannot be marked taken"', async () => {
    const { post } = setup([dose('08:00', 'pending')])
    post.mockRejectedValue(new ApiError(409, 'A skipped dose cannot be marked taken.', { detail: 'A skipped dose cannot be marked taken.' }))
    await screen.findByText('Upcoming')
    await userEvent.click(takenButton('08:00'))
    expect(await screen.findByText(/already marked as skipped, so it can't be marked as taken/)).toBeInTheDocument()
  })
})

describe('Today page: the adherence card', () => {
  it('shows the 30-day ring with a text alternative, counts and streak', async () => {
    setup([dose('08:00')])
    expect(await screen.findByRole('img', { name: 'Adherence 96 percent' })).toBeInTheDocument()
    expect(screen.getByText('21 taken · 1 missed · 2 skipped')).toBeInTheDocument()
    expect(screen.getByText('Current streak: 14 doses in a row')).toBeInTheDocument()
  })

  it('still shows the doses when only the adherence report fails', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.includes('/reports/')) throw new Error('report down')
      return [dose('08:00')] as never
    })
    renderWithProviders(<TodayPage />, { auth: authValue(makeUser('patient')) })
    expect(await screen.findByText('Metformin')).toBeInTheDocument()
    expect(await screen.findByText(/could not load your adherence/i)).toBeInTheDocument()
  })
})

describe('Today page: accessibility', () => {
  it('has no violations with doses showing', async () => {
    setup([dose('08:00', 'reminded'), dose('13:00', 'missed'), dose('20:00', 'taken')])
    await screen.findByRole('img', { name: /adherence/i })
    await expectNoA11yViolations(document.body)
  })

  it('has no violations with an error toast showing', async () => {
    const { post } = setup([dose('08:00')])
    post.mockRejectedValue(new ApiError(0, "Can't reach the server."))
    await screen.findByText('Upcoming')
    await userEvent.click(skipButton('08:00'))
    await screen.findByRole('alert')
    await expectNoA11yViolations(document.body)
  })
})
