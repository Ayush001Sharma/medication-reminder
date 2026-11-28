import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

let shouldThrow = true
function Fragile() {
  if (shouldThrow) throw new Error('boom')
  return <p>All good</p>
}

afterEach(() => {
  shouldThrow = true
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('shows a calm message instead of a blank screen, and recovers with Try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Something went wrong on this page' })).toBeInTheDocument()
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument()
    shouldThrow = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  it('renders its children untouched when nothing fails', () => {
    shouldThrow = false
    function Wrapper() {
      const [n] = useState(1)
      return <ErrorBoundary><p>Count {n}</p></ErrorBoundary>
    }
    render(<Wrapper />)
    expect(screen.getByText('Count 1')).toBeInTheDocument()
  })
})
