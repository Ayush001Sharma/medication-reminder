import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { Role } from '../../api/types'
import { expectNoA11yViolations } from '../../test/axe'
import { authValue, makeUser, renderWithProviders } from '../../test/helpers'
import { AppShell } from './AppShell'

function renderShell(role: Role, route = '/') {
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="*" element={<p>Page body</p>} />
      </Route>
    </Routes>,
    { route, auth: authValue(makeUser(role)) },
  )
}

const linkLabels = (nav: HTMLElement) => within(nav).getAllByRole('link').map((link) => link.textContent)

describe('AppShell navigation follows the role', () => {
  it('patients get Today, Upcoming, Medications, Sharing and Activity', () => {
    renderShell('patient')
    expect(linkLabels(screen.getByRole('navigation', { name: 'Main' }))).toEqual(['Today', 'Upcoming', 'Medications', 'Sharing', 'Activity'])
    expect(linkLabels(screen.getByRole('navigation', { name: 'Main (mobile)' }))).toEqual(['Today', 'Upcoming', 'Medications', 'Sharing', 'Activity'])
  })

  it.each<Role>(['caregiver', 'doctor'])('%ss get Patients and Invitations only', (role) => {
    renderShell(role)
    expect(linkLabels(screen.getByRole('navigation', { name: 'Main' }))).toEqual(['Patients', 'Invitations'])
  })

  it('marks the current page for assistive technology', () => {
    renderShell('patient', '/sharing')
    const desktop = screen.getByRole('navigation', { name: 'Main' })
    expect(within(desktop).getByRole('link', { name: 'Sharing' })).toHaveAttribute('aria-current', 'page')
    expect(within(desktop).getByRole('link', { name: 'Today' })).not.toHaveAttribute('aria-current')
  })

  it('has a skip link and a main landmark, plus the logo linking home', () => {
    renderShell('patient')
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main')
    expect(screen.getByRole('main')).toHaveTextContent('Page body')
    expect(screen.getByRole('link', { name: 'MedReminder' })).toHaveAttribute('href', '/')
  })

  it('the mobile bar is hidden from the desktop breakpoint and the top nav from mobile (via CSS classes)', () => {
    renderShell('patient')
    expect(screen.getByRole('navigation', { name: 'Main (mobile)' })).toHaveClass('md:hidden')
    expect(screen.getByRole('navigation', { name: 'Main' })).toHaveClass('hidden', 'md:flex')
  })

  it('has no accessibility violations', async () => {
    const { container } = renderShell('patient')
    await expectNoA11yViolations(container)
  })
})

describe('user menu', () => {
  it('opens to show who you are and your role, and closes with Escape returning focus to the button', async () => {
    renderShell('doctor')
    const trigger = screen.getByRole('button', { name: /account menu for dr\. rao/i })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Account' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(within(menu).getByText('doctor@example.com')).toBeInTheDocument()
    expect(within(menu).getByText('Doctor')).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes when you click elsewhere', async () => {
    renderShell('patient')
    await userEvent.click(screen.getByRole('button', { name: /account menu/i }))
    await userEvent.click(screen.getByRole('main'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('signs out', async () => {
    const { auth } = renderShell('patient')
    await userEvent.click(screen.getByRole('button', { name: /account menu/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(auth.logout).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('falls back to the email when there is no name', () => {
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={null} />
        </Route>
      </Routes>,
      { auth: authValue(makeUser('caregiver', { full_name: '' })) },
    )
    expect(screen.getByRole('button', { name: /account menu for caregiver@example\.com/i })).toBeInTheDocument()
  })
})
