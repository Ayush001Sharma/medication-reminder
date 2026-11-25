import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api/client'
import type { AuditEntry, Page } from '../../api/types'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { ActivityPage } from './ActivityPage'

const entry = (id: number, overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id, action: 'report_view', viewer_email: `viewer${id}@example.com`, viewer_role: 'doctor',
  range_start: '2026-10-27', range_end: '2026-11-25', created_at: '2026-11-25T09:00:00Z', ...overrides,
})
const page = (results: AuditEntry[], count = results.length): Page<AuditEntry> => ({ count, next: null, previous: null, results })
const render = (route = '/activity') => renderWithProviders(<ActivityPage />, { route, auth: authValue(makeUser('patient')) })

afterEach(() => vi.restoreAllMocks())

describe('ActivityPage', () => {
  it('shows a loading state', () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => undefined))
    render()
    expect(screen.getByText('Loading your activity…')).toBeInTheDocument()
  })

  it('lists who viewed what, in the order the API sends (newest first), with times in the patient\'s timezone', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValue(
      page([
        entry(3, { created_at: '2026-11-25T09:00:00Z' }),
        entry(2, { action: 'weekly_summary', viewer_role: 'caregiver', created_at: '2026-11-24T22:00:00Z', range_start: '2026-11-16', range_end: '2026-11-22' }),
        entry(1, { created_at: '2026-11-20T01:00:00Z' }),
      ]) as never,
    )
    render()
    const list = await screen.findByRole('list', { name: 'Access log, newest first' })
    const rows = within(list).getAllByRole('listitem') as [HTMLElement, HTMLElement, HTMLElement]
    expect(rows.map((row) => within(row).getByText(/@example\.com/).textContent)).toEqual(['viewer3@example.com', 'viewer2@example.com', 'viewer1@example.com'])
    expect(rows[0]).toHaveTextContent('viewer3@example.com viewed your report')
    expect(rows[0]).toHaveTextContent('Doctor')
    expect(rows[0]).toHaveTextContent('Covering 27 Oct 2026 to 25 Nov 2026')
    expect(rows[0]).toHaveTextContent('25 Nov 2026, 14:30') // 09:00 UTC is 14:30 in Asia/Kolkata
    expect(rows[1]).toHaveTextContent('viewer2@example.com was emailed your weekly summary')
    expect(rows[1]).toHaveTextContent('Caregiver')
    expect(rows[1]).toHaveTextContent('25 Nov 2026, 03:30') // 22:00 UTC on the 24th is already the 25th in Kolkata
    expect(within(rows[0]).getByText('25 Nov 2026, 14:30')).toHaveAttribute('datetime', '2026-11-25T09:00:00Z')
    expect(spy).toHaveBeenCalledWith('/api/audit-log/', expect.objectContaining({ query: { limit: 20, offset: 0 } }))
  })

  it('shows a calm empty state when nobody has looked', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(page([]) as never)
    render()
    expect(await screen.findByRole('heading', { name: 'Nobody has looked yet' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument()
  })

  it('offers a retry when loading fails', async () => {
    const spy = vi.spyOn(api, 'get').mockRejectedValue(new Error('down'))
    render()
    expect(await screen.findByText(/could not load your activity/i)).toBeInTheDocument()
    spy.mockResolvedValue(page([entry(1)]) as never)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('viewer1@example.com')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(page([entry(1), entry(2)], 45) as never)
    const { container } = render()
    await screen.findByText('viewer1@example.com')
    await expectNoA11yViolations(container)
  })
})

describe('ActivityPage: pagination', () => {
  const twenty = (from: number) => Array.from({ length: 20 }, (_, i) => entry(from - i))

  it('pages through the log 20 at a time with Previous and Next', async () => {
    const spy = vi.spyOn(api, 'get').mockImplementation((_path: string, options?: { query?: { offset?: number } }) => {
      const offset = options?.query?.offset ?? 0
      return Promise.resolve(page(offset === 0 ? twenty(45) : offset === 20 ? twenty(25) : [entry(5), entry(4), entry(3), entry(2), entry(1)], 45)) as never
    })
    render()
    const pager = await screen.findByRole('navigation', { name: 'Pagination' })
    expect(pager).toHaveTextContent('Showing 1–20 of 45')
    expect(pager).toHaveTextContent('Page 1 of 3')
    expect(within(pager).getByRole('button', { name: 'Previous' })).toBeDisabled()

    await userEvent.click(within(pager).getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('viewer25@example.com')).toBeInTheDocument()
    expect(spy).toHaveBeenLastCalledWith('/api/audit-log/', expect.objectContaining({ query: { limit: 20, offset: 20 } }))
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toHaveTextContent('Showing 21–40 of 45')

    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('viewer1@example.com')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toHaveTextContent('Showing 41–45 of 45')
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(await screen.findByText('viewer25@example.com')).toBeInTheDocument()
    expect(spy).toHaveBeenLastCalledWith('/api/audit-log/', expect.objectContaining({ query: { limit: 20, offset: 20 } }))
  })

  it('opens the page named in the address, and falls back to page 1 for nonsense', async () => {
    const spy = vi.spyOn(api, 'get').mockResolvedValue(page(twenty(45), 45) as never)
    const view = render('/activity?page=3')
    await screen.findByRole('navigation', { name: 'Pagination' })
    expect(spy).toHaveBeenCalledWith('/api/audit-log/', expect.objectContaining({ query: { limit: 20, offset: 40 } }))
    view.unmount()

    spy.mockClear()
    render('/activity?page=abc')
    await screen.findByRole('navigation', { name: 'Pagination' })
    expect(spy).toHaveBeenCalledWith('/api/audit-log/', expect.objectContaining({ query: { limit: 20, offset: 0 } }))
  })

  it('handles a page past the end (for example after entries were removed) with a way back', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(page([], 5) as never)
    render('/activity?page=9')
    expect(await screen.findByRole('heading', { name: 'That page is empty' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to the newest' })).toBeInTheDocument()
  })
})
