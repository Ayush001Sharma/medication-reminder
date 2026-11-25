import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoA11yViolations } from '../test/axe'
import { authValue, renderWithProviders } from '../test/helpers'
import { LandingPage } from './LandingPage'

const render = () => renderWithProviders(<LandingPage />, { auth: authValue(null) })

describe('LandingPage', () => {
  it('says what the app is, with one h1 and two clear ways in', () => {
    render()
    expect(screen.getByRole('heading', { level: 1, name: /Gentle reminders for the medicine that matters/ })).toBeInTheDocument()
    expect(screen.getByText(/keeps a quiet record of what you have taken/)).toBeInTheDocument()
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('link', { name: 'Create your account' })).toHaveAttribute('href', '/register')
    expect(main.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    expect(screen.getAllByRole('link', { name: 'Sign in' })).toHaveLength(2) // header and hero
  })

  it('lists what it offers and does not claim to give medical advice', () => {
    render()
    const features = within(screen.getByRole('region', { name: 'Made to feel easy' })).getAllByRole('listitem')
    expect(features.map((li) => within(li).getByRole('heading').textContent)).toEqual(['Reminders on your clock', 'A calm view of your day', 'Sharing on your terms'])
    expect(screen.getByRole('contentinfo')).toHaveTextContent('does not give medical advice')
  })

  it('draws the illustration from inline SVG shapes, hidden from assistive technology, using only theme colours', () => {
    const { container } = render()
    const svg = container.querySelector('main svg[aria-hidden="true"]')
    expect(svg).not.toBeNull()
    expect(svg?.querySelectorAll('rect, circle, path').length).toBeGreaterThan(20)
    expect(container.querySelectorAll('img')).toHaveLength(0) // no pictures to license
    expect(svg?.outerHTML).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i)
  })

  it('shows no demo mode', () => {
    render()
    expect(screen.queryByText(/Try as|Demo mode/)).not.toBeInTheDocument()
  })

  it('sets the tab title to the app name alone', () => {
    render()
    expect(document.title).toBe('MedReminder')
  })

  it('has no accessibility violations', async () => {
    const { container } = render()
    await expectNoA11yViolations(container)
  })
})
