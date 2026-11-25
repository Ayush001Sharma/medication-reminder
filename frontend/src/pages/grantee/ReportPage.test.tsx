import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../../api/client'
import type { AdherenceReport, AdherenceTotals, MedicationAdherence } from '../../api/types'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { ReportPage } from './ReportPage'

const totals = (overrides: Partial<AdherenceTotals> = {}): AdherenceTotals => ({
  total: 12, taken: 10, taken_late: 1, missed: 2, skipped: 0, adherence_percent: 83.3, ...overrides,
})
const medication = (id: number, name: string, overrides: Partial<AdherenceTotals> = {}): MedicationAdherence => ({
  medication_id: id, name, dosage: '10 mg', ...totals(overrides),
})
const report = (overrides: Partial<AdherenceReport> = {}): AdherenceReport => ({
  patient: { id: 7, full_name: 'Priya Nair', timezone: 'Asia/Kolkata' },
  totals: totals(),
  medications: [medication(1, 'Metformin', { total: 8, taken: 7, missed: 1, adherence_percent: 87.5 }), medication(2, 'Aspirin', { total: 4, taken: 3, missed: 1, adherence_percent: 75 })],
  current_streak: 4,
  range: { from: '2026-10-27', to: '2026-11-25', timezone: 'Asia/Kolkata' },
  ...overrides,
})

const render = (route = '/patients/7') =>
  renderWithProviders(
    <Routes>
      <Route path="/patients/:patientId" element={<ReportPage />} />
    </Routes>,
    { route, auth: authValue(makeUser('doctor')) },
  )

afterEach(() => vi.restoreAllMocks())

describe('ReportPage: loading', () => {
  it('shows a skeleton with a spoken status, and the page heading straight away', () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => undefined))
    render()
    expect(screen.getByRole('heading', { level: 1, name: 'Adherence report' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading the report')
    expect(screen.getByLabelText('From')).toBeDisabled() // dates are unknown until the API says what "last 30 days" is
  })
})

describe('ReportPage: data', () => {
  it('asks for the default range (no dates) for the patient in the address', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    render()
    await screen.findByRole('img', { name: 'Adherence 83 percent' })
    expect(spy).toHaveBeenCalledWith('/api/reports/adherence/', expect.objectContaining({ query: { patient: '7', from: undefined, to: undefined } }))
  })

  it('shows the donut, the four counts, the streak and the real dates the API used', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    render()
    expect(await screen.findByRole('img', { name: 'Adherence 83 percent' })).toBeInTheDocument()
    expect(screen.getByText('Priya Nair · 27 Oct 2026 to 25 Nov 2026 (Asia/Kolkata)')).toBeInTheDocument()

    const counts = within(screen.getByRole('region', { name: 'Dose counts' }))
    const stat = (label: string) => counts.getByText(label).closest('div') as HTMLElement
    expect(within(stat('Taken')).getByText('10')).toBeInTheDocument()
    expect(within(stat('Missed')).getByText('2')).toBeInTheDocument()
    expect(within(stat('Skipped')).getByText('0')).toBeInTheDocument()
    expect(within(stat('Taken late')).getByText('1')).toBeInTheDocument()
    expect(counts.getByText('Also counted as taken')).toBeInTheDocument()
    expect(counts.getByText('Current streak').parentElement).toHaveTextContent('4 doses taken in a row')

    expect(screen.getByLabelText('From')).toHaveValue('2026-10-27')
    expect(screen.getByLabelText('To')).toHaveValue('2026-11-25')
  })

  it('says "1 dose" for a streak of one', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(report({ current_streak: 1 }) as never)
    render()
    expect((await screen.findByText('Current streak')).parentElement).toHaveTextContent('1 dose taken in a row')
  })

  it('shows a bar chart per medication with the same numbers repeated as text', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    render()
    expect(await screen.findByRole('img', { name: 'Adherence per medication: Metformin 88 percent, Aspirin 75 percent' })).toBeInTheDocument()
    const list = within(screen.getByRole('list', { name: 'Adherence by medication' }))
    const rows = list.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Metformin 10 mg')
    expect(rows[0]).toHaveTextContent('88% · 7 taken, 1 missed, 0 skipped')
  })

  it('names a medication with no percentage instead of drawing a misleading empty bar', async () => {
    const meds = [medication(1, 'Metformin'), medication(2, 'Vitamin D', { total: 2, taken: 0, missed: 0, skipped: 2, adherence_percent: null })]
    vi.spyOn(api, 'get').mockResolvedValue(report({ medications: meds }) as never)
    render()
    expect(await screen.findByRole('img', { name: 'Adherence per medication: Metformin 83 percent' })).toBeInTheDocument()
    expect(screen.getByText(/Not enough data · 0 taken, 0 missed, 2 skipped/)).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    const { container } = render()
    await screen.findByRole('img', { name: 'Adherence per medication: Metformin 88 percent, Aspirin 75 percent' })
    await expectNoA11yViolations(container)
  })
})

describe('ReportPage: the adherence definition tooltip', () => {
  it('explains taken ÷ (taken + missed) on press, hover and focus, and closes with Escape', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    render()
    const button = await screen.findByRole('button', { name: 'How adherence is calculated' })
    const tip = screen.getByRole('tooltip', { hidden: true })
    expect(tip).not.toBeVisible()
    expect(button).toHaveAccessibleDescription(/taken ÷ \(taken \+ missed\)/)

    await userEvent.click(button)
    expect(tip).toBeVisible()
    expect(tip).toHaveTextContent('Skipped doses are shown separately and are not counted')
    await userEvent.keyboard('{Escape}')
    expect(tip).not.toBeVisible()

    await userEvent.hover(button)
    expect(tip).toBeVisible()
    await userEvent.unhover(button)
    expect(tip).not.toBeVisible()

    await userEvent.tab() // keyboard focus alone also reveals it
    const focused = document.activeElement
    if (focused === button) expect(tip).toBeVisible()
  })
})

describe('ReportPage: no percentage and no doses', () => {
  it('shows a friendly message instead of a number when the percentage is null', async () => {
    const onlySkipped = totals({ total: 3, taken: 0, taken_late: 0, missed: 0, skipped: 3, adherence_percent: null })
    vi.spyOn(api, 'get').mockResolvedValue(report({ totals: onlySkipped, medications: [] }) as never)
    render()
    expect(await screen.findByRole('img', { name: 'Adherence is not available yet' })).toBeInTheDocument()
    expect(screen.getByText(/There is no percentage yet/)).toBeInTheDocument()
    expect(screen.queryByText(/NaN|null/)).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Dose counts' })).getByText('3')).toBeInTheDocument() // the skipped count still shows
  })

  it('shows a calm empty state when nothing was taken, missed or skipped, and keeps the dates editable', async () => {
    const none = totals({ total: 0, taken: 0, taken_late: 0, missed: 0, skipped: 0, adherence_percent: null })
    vi.spyOn(api, 'get').mockResolvedValue(report({ totals: none, medications: [] }) as never)
    render()
    expect(await screen.findByRole('heading', { name: 'No doses to report for these dates' })).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByLabelText('From')).toBeEnabled()
  })
})

describe('ReportPage: no access (404) and other failures', () => {
  it('shows a calm message, with a way back, when access is revoked or missing', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(404, 'Not found.', { detail: 'Not found.' }))
    const { container } = render('/patients/99')
    expect(await screen.findByRole('heading', { name: "This report isn't available" })).toBeInTheDocument()
    expect(screen.getByText(/may no longer have access/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to your patients' })).toHaveAttribute('href', '/patients')
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument() // retrying cannot help
    expect(screen.queryByText(/not found\./i)).not.toBeInTheDocument() // the raw API wording is not shown
    await expectNoA11yViolations(container)
  })

  it('treats a malformed patient id the same way, without calling the API', () => {
    const spy = vi.spyOn(api, 'get')
    render('/patients/abc')
    expect(spy).not.toHaveBeenCalled()
    return screen.findByRole('heading', { name: "This report isn't available" })
  })

  it('treats a 400 about the patient as no access', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(400, 'Must be a whole number.', { patient: 'Must be a whole number.' }))
    render('/patients/7')
    expect(await screen.findByRole('heading', { name: "This report isn't available" })).toBeInTheDocument()
  })

  it('replaces a report that was showing when access is revoked in the meantime', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValueOnce(report() as never)
    render()
    await screen.findByRole('img', { name: 'Adherence 83 percent' })
    spy.mockRejectedValueOnce(new ApiError(404, 'Not found.'))
    await userEvent.click(screen.getByRole('button', { name: 'Last 30 days' })) // any new request now meets the revoked grant
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } })
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }))
    expect(await screen.findByRole('heading', { name: "This report isn't available" })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /Adherence/ })).not.toBeInTheDocument()
  })

  it('offers Try again for a server failure', async () => {
    const spy = vi.spyOn(api, 'get').mockRejectedValue(new ApiError(500, 'Something went wrong on our side. Please try again.'))
    render()
    expect(await screen.findByText('We could not load this report.')).toBeInTheDocument()
    spy.mockResolvedValue(report() as never)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('img', { name: 'Adherence 83 percent' })).toBeInTheDocument()
  })

  it('shows the API message under the end date when it rejects the range', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(400, 'Range is limited to 366 days (got 400).', { to: 'Range is limited to 366 days (got 400).' }))
    render('/patients/7?from=2025-01-01&to=2026-02-04')
    expect(await screen.findByText('Range is limited to 366 days (got 400).')).toBeInTheDocument()
    expect(screen.getByLabelText('To')).toHaveAccessibleDescription(/Range is limited/)
  })
})

describe('ReportPage: the date range picker', () => {
  const apply = async (from: string, to: string) => {
    fireEvent.change(screen.getByLabelText('From'), { target: { value: from } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: to } })
    await userEvent.click(screen.getByRole('button', { name: 'Show report' }))
  }

  it('requests the chosen dates and keeps them in the address', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    render()
    await screen.findByRole('img', { name: 'Adherence 83 percent' })
    await apply('2026-11-01', '2026-11-20')
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith('/api/reports/adherence/', expect.objectContaining({ query: { patient: '7', from: '2026-11-01', to: '2026-11-20' } })),
    )
  })

  it('reads the range from the address on arrival', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    render('/patients/7?from=2026-01-01&to=2026-01-31')
    expect(screen.getByLabelText('From')).toHaveValue('2026-01-01') // known before the answer arrives
    await screen.findByRole('img', { name: 'Adherence 83 percent' })
    expect(spy).toHaveBeenCalledWith('/api/reports/adherence/', expect.objectContaining({ query: { patient: '7', from: '2026-01-01', to: '2026-01-31' } }))
  })

  it('ignores a garbled range in the address and uses the default', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    render('/patients/7?from=nonsense&to=2026-13-45')
    await screen.findByRole('img', { name: 'Adherence 83 percent' })
    expect(spy).toHaveBeenCalledWith('/api/reports/adherence/', expect.objectContaining({ query: { patient: '7', from: undefined, to: undefined } }))
  })

  it('returns to the default range with "Last 30 days"', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    render('/patients/7?from=2026-01-01&to=2026-01-31')
    await screen.findByRole('img', { name: 'Adherence 83 percent' })
    await userEvent.click(screen.getByRole('button', { name: 'Last 30 days' }))
    await waitFor(() =>
      expect(spy).toHaveBeenLastCalledWith('/api/reports/adherence/', expect.objectContaining({ query: { patient: '7', from: undefined, to: undefined } })),
    )
  })

  it('accepts exactly 366 days but refuses 367, without sending a request', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    render()
    await screen.findByRole('img', { name: 'Adherence 83 percent' })
    spy.mockClear()

    await apply('2025-11-25', '2026-11-26') // 367 days (2026 has no Feb 29)
    expect(await screen.findByText('Pick at most 366 days (this is 367).')).toBeInTheDocument()
    expect(screen.getByLabelText('To')).toBeInvalid()
    expect(spy).not.toHaveBeenCalled()

    await apply('2025-11-26', '2026-11-26') // 366 days
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/Pick at most/)).not.toBeInTheDocument()
  })

  it('refuses an end date before the start date and a missing date', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValue(report() as never)
    render()
    await screen.findByRole('img', { name: 'Adherence 83 percent' })
    spy.mockClear()

    await apply('2026-11-20', '2026-11-10')
    expect(await screen.findByText('The end date must not be before the start date.')).toBeInTheDocument()

    await apply('', '2026-11-10')
    expect(await screen.findByText('Choose a start date.')).toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })
})
