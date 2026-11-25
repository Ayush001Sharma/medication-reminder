import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('AdherenceRing motion', () => {
  const preference = (reduce: boolean) =>
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce'), addEventListener: () => undefined, removeEventListener: () => undefined }))
  afterEach(() => vi.useRealTimers())

  it('counts the number up to the real value when motion is allowed', () => {
    preference(false)
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    render(<AdherenceRing percent={80} />)
    expect(screen.getByText('0%')).toBeInTheDocument() // starts empty, in step with the ring sweeping in
    act(() => void vi.advanceTimersByTime(1000))
    expect(screen.getByText('80%')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Adherence 80 percent' })).toBeInTheDocument() // the spoken value never counts
  })

  it('shows the final number immediately when the person prefers reduced motion', () => {
    preference(true)
    render(<AdherenceRing percent={80} />)
    expect(screen.getByText('80%')).toBeInTheDocument()
  })
})
