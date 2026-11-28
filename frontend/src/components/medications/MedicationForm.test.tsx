import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../../api/client'
import type { Medication, Schedule } from '../../api/types'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { MedicationForm } from './MedicationForm'

const TODAY = '2026-11-25'

function renderForm(props: Partial<Parameters<typeof MedicationForm>[0]> = {}) {
  return renderWithProviders(
    <Routes>
      <Route path="/form" element={<MedicationForm mode="create" timeZone="Asia/Kolkata" today={TODAY} {...props} />} />
      <Route path="/medications" element={<p>Medication list page</p>} />
    </Routes>,
    { route: '/form', auth: authValue(makeUser('patient')) },
  )
}

/** Date and time inputs are set directly: their typing behaviour differs between browsers and jsdom. */
const setField = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const text = (label: string, value: string) => userEvent.type(screen.getByLabelText(label), value)
const submit = () => userEvent.click(screen.getByRole('button', { name: /^(Add medication|Save changes)$/ }))

async function addTimeChip(time: string) {
  setField('Add a time', time)
  await userEvent.click(screen.getByRole('button', { name: 'Add time' }))
}

async function fillValidForm() {
  await text('Name', 'Metformin')
  await text('Dosage', '500 mg')
  await addTimeChip('20:00')
  await addTimeChip('08:00')
}

const created: Medication = { id: 42, name: 'Metformin', dosage: '500 mg', instructions: '', start_date: TODAY, end_date: null, is_active: true }

describe('validation messages (before anything is sent)', () => {
  it('shows every missing required field at once, focuses the first, and sends nothing', async () => {
    const post = vi.spyOn(api, 'post')
    renderForm()
    await submit()
    expect(screen.getByText('Enter the medication name.')).toBeInTheDocument()
    expect(screen.getByText('Enter the dosage, for example 500 mg.')).toBeInTheDocument()
    expect(screen.getByText('Add at least one time of day.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Please fix the highlighted fields.')
    expect(screen.getByLabelText('Name')).toHaveFocus()
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(post).not.toHaveBeenCalled()
  })

  it('clears a field\'s error as soon as the person fixes it', async () => {
    renderForm()
    await submit()
    await text('Name', 'A')
    expect(screen.queryByText('Enter the medication name.')).not.toBeInTheDocument()
    expect(screen.getByText('Enter the dosage, for example 500 mg.')).toBeInTheDocument() // others stay until fixed
  })

  it('checks the dates: end before start, end in the past, missing start', async () => {
    renderForm()
    await fillValidForm()
    setField('Start date', '2026-12-10')
    setField('End date (optional)', '2026-12-01')
    await submit()
    expect(screen.getByText('The end date cannot be before the start date.')).toBeInTheDocument()

    setField('Start date', '2026-11-01')
    setField('End date (optional)', '2026-11-20') // before today (25 Nov) but after the start
    await submit()
    expect(screen.getByText('The end date cannot be in the past.')).toBeInTheDocument()

    setField('Start date', '')
    await submit()
    expect(screen.getByText('Choose a start date.')).toBeInTheDocument()
  })

  it('needs at least one day', async () => {
    renderForm()
    await fillValidForm()
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) await userEvent.click(screen.getByRole('button', { name: day }))
    await submit()
    expect(screen.getByText('Choose at least one day.')).toBeInTheDocument()
  })
})

describe('time chips', () => {
  it('adds times as chips, kept in order', async () => {
    renderForm()
    await addTimeChip('20:00')
    await addTimeChip('08:00')
    const chips = within(screen.getByRole('list', { name: 'Chosen times' })).getAllByRole('listitem')
    expect(chips.map((chip) => chip.textContent)).toEqual(['08:00', '20:00']) // sorted, whatever the order they were added in
  })

  it('refuses a duplicate with a clear message', async () => {
    renderForm()
    await addTimeChip('08:00')
    await addTimeChip('08:00')
    expect(screen.getByText('08:00 is already in the list.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1)
  })

  it('asks for a time when none is chosen, and the message goes away when you type', async () => {
    renderForm()
    await userEvent.click(screen.getByRole('button', { name: 'Add time' }))
    expect(screen.getByText('Choose a time first.')).toBeInTheDocument()
    setField('Add a time', '09:00')
    expect(screen.queryByText('Choose a time first.')).not.toBeInTheDocument()
  })

  it('removes a chip', async () => {
    renderForm()
    await addTimeChip('08:00')
    await addTimeChip('20:00')
    await userEvent.click(screen.getByRole('button', { name: 'Remove 08:00' }))
    expect(screen.queryByRole('button', { name: 'Remove 08:00' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove 20:00' })).toBeInTheDocument()
  })

  it('Enter in the time box adds the time and does NOT submit the form', async () => {
    const post = vi.spyOn(api, 'post')
    renderForm()
    setField('Add a time', '07:30')
    screen.getByLabelText('Add a time').focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Remove 07:30' })).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
    expect(screen.queryByText('Enter the medication name.')).not.toBeInTheDocument()
  })

  it('says which timezone the times are in', () => {
    renderForm({ timeZone: 'America/New_York' })
    expect(screen.getByText(/America\/New York/)).toBeInTheDocument()
  })
})

describe('day-of-week toggles', () => {
  it('starts with every day on, and each button reports its state', async () => {
    renderForm()
    const monday = screen.getByRole('button', { name: 'Monday' })
    expect(monday).toHaveAttribute('aria-pressed', 'true')
    expect(monday).toHaveTextContent('Mon')
    await userEvent.click(monday)
    expect(monday).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(monday)
    expect(monday).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('saving a new medication', () => {
  it('creates the medication, then its schedule with the right payloads, then goes back to the list', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(created as never).mockResolvedValueOnce({ id: 7 } as never)
    renderForm()
    await fillValidForm()
    await text('Instructions (optional)', ' With food ')
    await userEvent.click(screen.getByRole('button', { name: 'Saturday' }))
    await userEvent.click(screen.getByRole('button', { name: 'Sunday' }))
    setField('End date (optional)', '2026-12-31')
    await submit()

    expect(post).toHaveBeenNthCalledWith(1, '/api/medications/', {
      name: 'Metformin', dosage: '500 mg', instructions: 'With food', start_date: TODAY, end_date: '2026-12-31',
    })
    expect(post).toHaveBeenNthCalledWith(2, '/api/medications/42/schedules/', {
      times_of_day: ['08:00', '20:00'], days_of_week: [0, 1, 2, 3, 4], start_date: TODAY, end_date: '2026-12-31',
    })
    expect(await screen.findByText('Medication list page')).toBeInTheDocument()
    expect(await screen.findByText('Metformin added.')).toBeInTheDocument()
  })

  it('sends no end date as null', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(created as never).mockResolvedValueOnce({} as never)
    renderForm()
    await fillValidForm()
    await submit()
    expect(post.mock.calls[0]?.[1]).toMatchObject({ end_date: null })
    expect(post.mock.calls[1]?.[1]).toMatchObject({ end_date: null })
  })

  it('disables the button and shows progress while saving', async () => {
    vi.spyOn(api, 'post').mockReturnValue(new Promise(() => undefined) as never)
    renderForm()
    await fillValidForm()
    await submit()
    const button = screen.getByRole('button', { name: 'Add medication' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })
})

describe("showing the API's validation errors", () => {
  it('puts each message under its field and keeps what was typed', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(
      new ApiError(400, 'Medication with this name exists.', { name: ['Medication with this name exists.'], end_date: ['End date cannot be in the past.'] }),
    )
    renderForm()
    await fillValidForm()
    setField('End date (optional)', '2026-12-31')
    await submit()
    expect(await screen.findByText('Medication with this name exists.')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription(/exists/)
    expect(screen.getByText('End date cannot be in the past.')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Metformin')
    expect(screen.getByRole('button', { name: 'Add medication' })).toBeEnabled()
    expect(screen.queryByText('Medication list page')).not.toBeInTheDocument()
  })

  it('shows nested list errors from the schedule under the times, and a retry does NOT create a second medication', async () => {
    const post = vi.spyOn(api, 'post')
    const patch = vi.spyOn(api, 'patch')
    post.mockResolvedValueOnce(created as never) // medication created...
    post.mockRejectedValueOnce(new ApiError(400, 'Time has wrong format.', { times_of_day: { '0': ['Time has wrong format. Use one of these formats instead: hh:mm.'] } })) // ...schedule refused
    renderForm()
    await fillValidForm()
    await submit()

    expect(await screen.findByText('Time has wrong format. Use one of these formats instead: hh:mm.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Metformin was saved, but its schedule was not.')

    // the person tries again: the medication is updated, the schedule created, and nothing is duplicated
    patch.mockResolvedValueOnce(created as never)
    post.mockResolvedValueOnce({ id: 7 } as never)
    await submit()
    expect(await screen.findByText('Medication list page')).toBeInTheDocument()
    expect(post.mock.calls.filter(([path]) => path === '/api/medications/')).toHaveLength(1)
    expect(patch).toHaveBeenCalledWith('/api/medications/42/', expect.objectContaining({ name: 'Metformin' }))
    expect(post).toHaveBeenLastCalledWith('/api/medications/42/schedules/', expect.any(Object))
  })

  it('shows a general message for errors that belong to no field, such as a lost connection', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(new ApiError(0, "Can't reach the server. Check your connection and try again."))
    renderForm()
    await fillValidForm()
    await submit()
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the server")
    expect(screen.getByLabelText('Name')).toHaveValue('Metformin')
  })
})

describe('editing', () => {
  const existing: Medication = { id: 9, name: 'Aspirin', dosage: '75 mg', instructions: 'After lunch', start_date: '2026-11-01', end_date: '2026-12-31', is_active: true }
  const schedule: Schedule = { id: 3, times_of_day: ['13:00:00'], days_of_week: [0, 2, 4], start_date: '2026-11-01', end_date: '2026-12-31', is_active: true }

  it('starts from the saved values, with the saved times and days', () => {
    renderForm({ mode: 'edit', medication: existing, schedule })
    expect(screen.getByLabelText('Name')).toHaveValue('Aspirin')
    expect(screen.getByLabelText('Dosage')).toHaveValue('75 mg')
    expect(screen.getByLabelText('Instructions (optional)')).toHaveValue('After lunch')
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-01')
    expect(screen.getByLabelText('End date (optional)')).toHaveValue('2026-12-31')
    expect(screen.getByRole('button', { name: 'Remove 13:00' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()
  })

  it('updates the medication and its schedule in place', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({} as never)
    const post = vi.spyOn(api, 'post')
    renderForm({ mode: 'edit', medication: existing, schedule })
    await text('Dosage', ' extra')
    await addTimeChip('21:00')
    await submit()
    expect(patch).toHaveBeenNthCalledWith(1, '/api/medications/9/', expect.objectContaining({ dosage: '75 mg extra' }))
    expect(patch).toHaveBeenNthCalledWith(2, '/api/medications/9/schedules/3/', {
      times_of_day: ['13:00', '21:00'], days_of_week: [0, 2, 4], start_date: '2026-11-01', end_date: '2026-12-31',
    })
    expect(post).not.toHaveBeenCalled()
    expect(await screen.findByText('Medication list page')).toBeInTheDocument()
    expect(await screen.findByText('Aspirin updated.')).toBeInTheDocument()
  })

  it('creates a schedule when the medication has none yet', async () => {
    vi.spyOn(api, 'patch').mockResolvedValue({} as never)
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never)
    renderForm({ mode: 'edit', medication: existing })
    await addTimeChip('09:00')
    await submit()
    expect(post).toHaveBeenCalledWith('/api/medications/9/schedules/', expect.objectContaining({ times_of_day: ['09:00'] }))
  })

  it('allows an already-expired end date to stay as it is (the API allows it)', async () => {
    const expired = { ...existing, end_date: '2026-11-10' }
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({} as never)
    renderForm({ mode: 'edit', medication: expired, schedule: { ...schedule, end_date: '2026-11-10' } })
    await text('Dosage', 'x')
    await submit()
    expect(screen.queryByText('The end date cannot be in the past.')).not.toBeInTheDocument()
    expect(patch).toHaveBeenCalled()
  })

  it('but a NEW end date in the past is refused', async () => {
    renderForm({ mode: 'edit', medication: existing, schedule })
    setField('End date (optional)', '2026-11-10')
    await submit()
    expect(screen.getByText('The end date cannot be in the past.')).toBeInTheDocument()
  })

  it('mentions extra schedules that cannot be edited here', () => {
    renderForm({ mode: 'edit', medication: existing, schedule, otherSchedules: 2 })
    expect(screen.getByText(/2 more schedules\. They are kept as they are/)).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('has no violations: empty, with errors, and filled in', async () => {
    const { container } = renderForm()
    await expectNoA11yViolations(container)
    await submit()
    await expectNoA11yViolations(container)
    await fillValidForm()
    await expectNoA11yViolations(container)
  })
})
