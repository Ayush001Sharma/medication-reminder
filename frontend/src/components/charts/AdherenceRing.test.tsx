import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AdherenceRing } from './AdherenceRing'

describe('AdherenceRing', () => {
  it('shows the percentage as text and describes it for screen readers', () => {
    const { container } = render(<AdherenceRing percent={95.2} />)
    expect(screen.getByRole('img', { name: 'Adherence 95 percent' })).toBeInTheDocument()
    expect(screen.getByText('95%')).toBeInTheDocument()
    expect(container.querySelector('svg')).toBeInTheDocument() // the Recharts donut
  })

  it('says so when there is nothing to show yet', () => {
    render(<AdherenceRing percent={null} />)
    expect(screen.getByRole('img', { name: 'Adherence is not available yet' })).toBeInTheDocument()
    expect(screen.getByText('–')).toBeInTheDocument()
  })

  it('keeps out-of-range values inside 0-100', () => {
    render(<AdherenceRing percent={140} />)
    expect(screen.getByRole('img', { name: 'Adherence 100 percent' })).toBeInTheDocument()
  })
})
