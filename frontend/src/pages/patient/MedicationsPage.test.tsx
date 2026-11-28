import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../../api/client'
import type { Medication, Schedule } from '../../api/types'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { EditMedicationPage } from './MedicationFormPages'
import { MedicationsPage } from './MedicationsPage'

const med = (id: number, overrides: Partial<Medication> = {}): Medication => ({
  id, name: `Medicine ${id}`, dosage: '500 mg', instructions: '', start_date: '2026-11-01', end_date: null, is_active: true, ...overrides,
})
const sched = (id: number, times: string[], days = [0, 1, 2, 3, 4, 5, 6]): Schedule => ({
  id, times_of_day: times, days_of_week: days, start_date: '2026-11-01', end_date: null, is_active: true,
})

/** Serve /api/medications/ and each medication's schedules. */
function serve(medications: Medication[], schedules: Record<number, Schedule[]> = {}) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    const match = /^\/api\/medications\/(\d+)\/schedules\/$/.exec(path)
    if (match) return (schedules[Number(match[1])] ?? []) as never
    return medications as never
  })
}

const render = () => renderWithProviders(<MedicationsPage />, { auth: authValue(makeUser('patient')) })

describe('MedicationsPage: the list', () => {
  it('shows a loading skeleton first', () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => undefined))
    render()
    expect(screen.getByText('Loading your medications…')).toBeInTheDocument()
  })

  it('lists each medication with its dosage, instructions, dates and schedule', async () => {
    serve(
      [med(1, { name: 'Metformin', instructions: 'With food' }), med(2, { name: 'Aspirin', dosage: '75 mg', end_date: '2026-12-31' })],
      { 1: [sched(10, ['20:00:00', '08:00:00'])], 2: [sched(11, ['13:00'], [0, 2, 4])] },
    )
    render()
    const metformin = await screen.findByRole('article', { name: 'Metformin' })
    expect(within(metformin).getByText('500 mg')).toBeInTheDocument()
    expect(within(metformin).getByText('With food')).toBeInTheDocument()
    expect(within(metformin).getByText('From 1 Nov 2026 · no end date')).toBeInTheDocument()
    expect(within(within(metformin).getByRole('list', { name: 'Times' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['08:00', '20:00'])
    expect(within(metformin).getByText('Every day')).toBeInTheDocument()

    const aspirin = screen.getByRole('article', { name: 'Aspirin' })
    expect(within(aspirin).getByText('From 1 Nov 2026 · until 31 Dec 2026')).toBeInTheDocument()
    expect(within(aspirin).getByText('Mon, Wed, Fri')).toBeInTheDocument()
  })

  it('says so when a medication has no schedule', async () => {
    serve([med(1)], {})
    render()
    expect(await screen.findByText('No schedule yet, so no reminders.')).toBeInTheDocument()
  })

  it('links to the add form and, per medication, to its edit page', async () => {
    serve([med(1, { name: 'Metformin' })], { 1: [sched(10, ['08:00'])] })
    render()
    expect(screen.getByRole('link', { name: 'Add medication' })).toHaveAttribute('href', '/medications/new')
    expect(await screen.findByRole('link', { name: 'Edit Metformin' })).toHaveAttribute('href', '/medications/1/edit')
  })

  it('lists stopped medications separately, read-only', async () => {
    serve([med(1, { name: 'Active one' }), med(2, { name: 'Old one', is_active: false })], { 1: [sched(10, ['08:00'])], 2: [sched(11, ['09:00'])] })
    render()
    await screen.findByRole('article', { name: 'Active one' })
    const stopped = screen.getByRole('region', { name: 'Stopped' })
    const old = within(stopped).getByRole('article', { name: 'Old one' })
    expect(within(old).getByText('Stopped')).toBeInTheDocument()
    expect(within(old).queryByRole('button')).not.toBeInTheDocument()
    expect(within(old).queryByRole('link')).not.toBeInTheDocument()
  })

  it('shows a welcoming empty state', async () => {
    serve([])
    render()
    expect(await screen.findByRole('heading', { name: 'No medications yet' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add your first medication' })).toHaveAttribute('href', '/medications/new')
  })

  it('shows an error with a retry', async () => {
    const get = vi.spyOn(api, 'get').mockRejectedValue(new Error('down'))
    render()
    expect(await screen.findByText(/could not load your medications/i)).toBeInTheDocument()
    get.mockImplementation(async () => [] as never)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No medications yet')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    serve([med(1, { name: 'Metformin' }), med(2, { name: 'Old', is_active: false })], { 1: [sched(10, ['08:00'])] })
    const { container } = render()
    await screen.findByRole('article', { name: 'Metformin' })
    await expectNoA11yViolations(container)
  })
})

describe('MedicationsPage: stopping a medication', () => {
  async function openStopDialog() {
    serve([med(1, { name: 'Metformin' })], { 1: [sched(10, ['08:00'])] })
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Stop Metformin' }))
    return screen.getByRole('dialog', { name: 'Stop Metformin?' })
  }

  it('asks first, and explains what will happen', async () => {
    const post = vi.spyOn(api, 'post')
    const dialog = await openStopDialog()
    expect(dialog).toHaveTextContent('Reminders stop and its upcoming doses are removed')
    expect(dialog).toHaveTextContent('Your dose history is kept')
    expect(dialog).toHaveTextContent("can't be undone from here")
    expect(post).not.toHaveBeenCalled()
  })

  it('"Keep it", Escape and the close button leave everything as it was', async () => {
    const post = vi.spyOn(api, 'post')
    const dialog = await openStopDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Stop Metformin' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Stop Metformin' })).toHaveFocus() // focus returns to the button that opened it
  })

  it('confirming deactivates it, moves it to Stopped, and says so', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never)
    const dialog = await openStopDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop medication' }))
    expect(post).toHaveBeenCalledWith('/api/medications/1/deactivate/')
    expect(await screen.findByText('Metformin stopped. Its upcoming reminders have been removed.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const stopped = screen.getByRole('region', { name: 'Stopped' })
    expect(within(stopped).getByRole('article', { name: 'Metformin' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop Metformin' })).not.toBeInTheDocument()
  })

  it('shows progress, and cannot be dismissed or repeated while the request is travelling', async () => {
    let finish: (value: unknown) => void = () => undefined
    const post = vi.spyOn(api, 'post').mockReturnValue(new Promise((resolve) => (finish = resolve)) as never)
    const dialog = await openStopDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop medication' }))
    expect(within(dialog).getByRole('button', { name: 'Stop medication' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    finish({})
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('a failure keeps the dialog open with the reason, and the medication stays active', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(0, "Can't reach the server. Check your connection and try again."))
    const dialog = await openStopDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop medication' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Can't reach the server")
    expect(within(dialog).getByRole('button', { name: 'Stop medication' })).toBeEnabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    expect(screen.getByRole('button', { name: 'Stop Metformin' })).toBeInTheDocument()
  })

  it('has no accessibility violations with the dialog open', async () => {
    await openStopDialog()
    await expectNoA11yViolations(document.body)
  })
})

describe('EditMedicationPage', () => {
  const renderEdit = (id = '1') =>
    renderWithProviders(
      <Routes>
        <Route path="/medications/:id/edit" element={<EditMedicationPage />} />
      </Routes>,
      { route: `/medications/${id}/edit`, auth: authValue(makeUser('patient')) },
    )

  const serveOne = (medication: Medication, schedules: Schedule[]) =>
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => (path.endsWith('/schedules/') ? schedules : medication) as never)

  it('loads the medication and its schedule into the form', async () => {
    const get = serveOne(med(1, { name: 'Aspirin' }), [sched(5, ['13:00:00'], [0, 2, 4])])
    renderEdit()
    expect(screen.getByText('Loading the medication…')).toBeInTheDocument()
    expect(await screen.findByLabelText('Name')).toHaveValue('Aspirin')
    expect(get).toHaveBeenCalledWith('/api/medications/1/', expect.any(Object))
    expect(get).toHaveBeenCalledWith('/api/medications/1/schedules/', expect.any(Object))
    expect(screen.getByRole('button', { name: 'Remove 13:00' })).toBeInTheDocument()
  })

  it('says so when the medication does not exist, with a way back', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(404, 'Not found.', { detail: 'Not found.' }))
    renderEdit('999')
    expect(await screen.findByRole('heading', { name: 'We could not find that medication' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to medications' })).toHaveAttribute('href', '/medications')
  })

  it('does not let a stopped medication be edited', async () => {
    serveOne(med(1, { is_active: false }), [])
    renderEdit()
    expect(await screen.findByRole('heading', { name: 'This medication has been stopped' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('offers a retry for other errors', async () => {
    const get = vi.spyOn(api, 'get').mockRejectedValue(new ApiError(500, 'Something went wrong on our side.'))
    renderEdit()
    expect(await screen.findByText(/could not load this medication/i)).toBeInTheDocument()
    get.mockImplementation(async (path: string) => (path.endsWith('/schedules/') ? [] : med(1, { name: 'Aspirin' })) as never)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByLabelText('Name')).toHaveValue('Aspirin')
  })
})
