import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../../test/axe'
import { ToastProvider } from '../../toast/ToastProvider'
import { useToast } from '../../toast/context'
import { Badge, DoseStatusBadge } from './Badge'
import { Button } from './Button'
import { ButtonLink } from './ButtonLink'
import { Card, CardTitle } from './Card'
import { EmptyState } from './EmptyState'
import { Input } from './Input'
import { Modal } from './Modal'
import { Select } from './Select'
import { LoadingRegion, Skeleton, SkeletonList } from './Skeleton'

describe('Button', () => {
  it('is a real button that defaults to type="button" and fires onClick', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toHaveAttribute('type', 'button')
    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('while loading it is disabled, busy, shows a spinner and ignores clicks, but keeps its label', async () => {
    const onClick = vi.fn()
    const { container } = render(<Button loading onClick={onClick}>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(container.querySelector('svg.animate-spin')).toBeInTheDocument()
    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('has large comfortable targets and token-only colours for every variant', () => {
    render(
      <>
        <Button>primary</Button>
        <Button variant="secondary">secondary</Button>
        <Button variant="ghost">ghost</Button>
        <Button variant="danger">danger</Button>
        <Button size="md">md</Button>
      </>,
    )
    expect(screen.getByRole('button', { name: 'primary' })).toHaveClass('bg-sage-dark', 'text-surface', 'min-h-12', 'rounded-2xl')
    expect(screen.getByRole('button', { name: 'danger' })).toHaveClass('bg-danger', 'text-surface')
    expect(screen.getByRole('button', { name: 'md' })).toHaveClass('min-h-11')
  })

  it('ButtonLink is a link with button styling', () => {
    render(<MemoryRouter><ButtonLink to="/today" variant="secondary">Go</ButtonLink></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute('href', '/today')
  })
})

describe('Card, EmptyState, Skeleton, Badge', () => {
  it('Card is a rounded white surface and CardTitle a heading', () => {
    render(<Card><CardTitle>Title</CardTitle>body</Card>)
    expect(screen.getByRole('heading', { name: 'Title' }).parentElement).toHaveClass('rounded-2xl', 'bg-surface', 'shadow-soft')
  })

  it('EmptyState shows title, description and a call to action', () => {
    render(<EmptyState title="Nothing yet" description="Add one to begin." action={<Button>Add</Button>} />)
    expect(screen.getByRole('heading', { name: 'Nothing yet' })).toBeInTheDocument()
    expect(screen.getByText('Add one to begin.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })

  it('EmptyState can be the page heading (h1) or a section heading (h2 by default)', () => {
    const { rerender } = render(<EmptyState title="Section" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toBeInTheDocument()
    rerender(<EmptyState title="Whole page" headingAs="h1" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Whole page' })).toBeInTheDocument()
  })

  it('Skeleton is hidden from assistive technology and LoadingRegion announces loading', () => {
    const { container } = render(<LoadingRegion label="Loading doses"><SkeletonList rows={2} /><Skeleton className="h-4" /></LoadingRegion>)
    expect(screen.getByRole('status')).toHaveTextContent('Loading doses…')
    container.querySelectorAll('.animate-pulse').forEach((node) => expect(node).toHaveAttribute('aria-hidden', 'true'))
    expect(container.querySelectorAll('.motion-reduce\\:animate-none').length).toBeGreaterThan(0)
  })

  it('Badge text carries the meaning, for every dose status', () => {
    render(
      <>
        <DoseStatusBadge status="pending" />
        <DoseStatusBadge status="reminded" />
        <DoseStatusBadge status="taken" />
        <DoseStatusBadge status="taken" late />
        <DoseStatusBadge status="missed" />
        <DoseStatusBadge status="skipped" />
        <Badge tone="danger">Alert</Badge>
      </>,
    )
    for (const label of ['Upcoming', 'Reminder sent', 'Taken', 'Taken late', 'Missed', 'Skipped', 'Alert']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('Missed')).toHaveClass('bg-clay', 'text-ink') // clay is a fill, never text
    expect(screen.getByText('Taken')).toHaveClass('bg-sage-tint', 'text-sage-dark')
  })
})

describe('Input and Select', () => {
  it('label, hint and error are programmatically connected', () => {
    render(<Input label="Email" hint="We never share it." error="Enter a valid email." />)
    const input = screen.getByLabelText('Email')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const described = input.getAttribute('aria-describedby') ?? ''
    expect(described.split(' ')).toHaveLength(2)
    expect(document.getElementById(described.split(' ')[0] ?? '')).toHaveTextContent('We never share it.')
    expect(document.getElementById(described.split(' ')[1] ?? '')).toHaveTextContent('Enter a valid email.')
    expect(input).toHaveClass('border-danger', 'min-h-12', 'rounded-2xl')
  })

  it('without hint or error there is nothing to describe, and the border is the 3:1 sage', () => {
    render(<Input label="Name" />)
    const input = screen.getByLabelText('Name')
    expect(input).not.toHaveAttribute('aria-describedby')
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input).toHaveClass('border-sage')
  })

  it('Select offers its options, reports changes and links its error', async () => {
    function Wrapper() {
      const [value, setValue] = useState('patient')
      return (
        <Select label="I am a" value={value} onChange={(e) => setValue(e.target.value)} error="Pick one.">
          <option value="patient">Patient</option>
          <option value="doctor">Doctor</option>
        </Select>
      )
    }
    render(<Wrapper />)
    const select = screen.getByLabelText('I am a')
    await userEvent.selectOptions(select, 'doctor')
    expect(select).toHaveValue('doctor')
    expect(select).toHaveAccessibleDescription('Pick one.')
  })
})

describe('Modal', () => {
  function Harness() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Open dialog</button>
        <p>Page content</p>
        <Modal open={open} onClose={() => setOpen(false)} title="Remove medication" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger">Remove</Button></>}>
          Are you sure?
        </Modal>
      </>
    )
  }

  afterEach(() => {
    document.body.style.overflow = ''
  })

  it('opens as a named modal dialog and moves focus into it', async () => {
    render(<Harness />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove medication' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveFocus()
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('Escape closes it, restores scrolling and returns focus to the button that opened it', async () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open dialog' })
    await userEvent.click(opener)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')
    expect(opener).toHaveFocus()
  })

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }))
    const dialog = screen.getByRole('dialog')
    const close = within(dialog).getByRole('button', { name: 'Close' })
    const remove = within(dialog).getByRole('button', { name: 'Remove' })
    await userEvent.tab() // dialog -> Close
    expect(close).toHaveFocus()
    await userEvent.tab()
    await userEvent.tab()
    expect(remove).toHaveFocus()
    await userEvent.tab() // wraps to the first control instead of leaving the dialog
    expect(close).toHaveFocus()
    await userEvent.tab({ shift: true }) // and backwards
    expect(remove).toHaveFocus()
  })

  it('closes from the close button, the footer and a click on the backdrop, but not a click inside', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }))
    await userEvent.click(screen.getByText('Are you sure?'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }))
    await userEvent.pointer({ keys: '[MouseLeft]', target: screen.getByRole('dialog').parentElement as HTMLElement })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }))
    await expectNoA11yViolations(document.body)
  })
})

describe('Toasts', () => {
  function Buttons() {
    const toast = useToast()
    return (
      <>
        <button onClick={() => toast.success('Saved.')}>ok</button>
        <button onClick={() => toast.error('Could not save.')}>fail</button>
        <button onClick={() => toast.info('FYI')}>info</button>
      </>
    )
  }
  const mount = () => render(<ToastProvider><Buttons /></ToastProvider>)

  afterEach(() => {
    vi.useRealTimers()
  })

  it('announces success politely and errors assertively', async () => {
    mount()
    await userEvent.click(screen.getByText('ok'))
    await userEvent.click(screen.getByText('fail'))
    expect(screen.getByRole('status')).toHaveTextContent('Saved.')
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.')
  })

  it('can carry an action button: clicking it dismisses the toast and runs the action once', async () => {
    const onClick = vi.fn()
    function WithAction() {
      const toast = useToast()
      return <button onClick={() => toast.error('Could not save.', { action: { label: 'Try again', onClick } })}>go</button>
    }
    render(<ToastProvider><WithAction /></ToastProvider>)
    await userEvent.click(screen.getByText('go'))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a toast with an action stays longer, so there is time to use it', () => {
    vi.useFakeTimers()
    function WithAction() {
      const toast = useToast()
      return <button onClick={() => toast.info('Heads up', { action: { label: 'Open', onClick: () => undefined } })}>go</button>
    }
    render(<ToastProvider><WithAction /></ToastProvider>)
    act(() => screen.getByText('go').click())
    act(() => vi.advanceTimersByTime(9000))
    expect(screen.getByText('Heads up')).toBeInTheDocument() // a plain info toast would be gone after 6 s
    act(() => vi.advanceTimersByTime(1100))
    expect(screen.queryByText('Heads up')).not.toBeInTheDocument()
  })

  it('can be dismissed by hand', async () => {
    mount()
    await userEvent.click(screen.getByText('ok'))
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
  })

  it('goes away by itself: errors stay longer than other messages', () => {
    vi.useFakeTimers()
    mount()
    act(() => screen.getByText('ok').click())
    act(() => screen.getByText('fail').click())
    act(() => vi.advanceTimersByTime(5999))
    expect(screen.getByText('Saved.')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(2))
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
    expect(screen.getByText('Could not save.')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(3100))
    expect(screen.queryByText('Could not save.')).not.toBeInTheDocument()
  })

  it('waits while the pointer is over a toast or focus is inside it, then carries on', () => {
    vi.useFakeTimers()
    mount()
    act(() => screen.getByText('ok').click())
    const toast = screen.getByRole('status')
    act(() => void fireEvent.mouseEnter(toast))
    act(() => vi.advanceTimersByTime(20000))
    expect(screen.getByText('Saved.')).toBeInTheDocument() // still there after far longer than 6 s
    act(() => void fireEvent.mouseLeave(toast))
    act(() => vi.advanceTimersByTime(6100))
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()

    act(() => screen.getByText('info').click())
    const info = screen.getByText('FYI').closest('[role="status"]') as HTMLElement
    act(() => void fireEvent.focus(info.querySelector('button') as HTMLElement))
    act(() => vi.advanceTimersByTime(20000))
    expect(screen.getByText('FYI')).toBeInTheDocument()
  })

  it('keeps at most four on screen', async () => {
    mount()
    for (let i = 0; i < 7; i++) await userEvent.click(screen.getByText('info'))
    expect(screen.getAllByText('FYI')).toHaveLength(4)
  })

  it('throws a clear error when used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hush = (event: ErrorEvent) => event.preventDefault() // jsdom would otherwise print the expected error
    window.addEventListener('error', hush)
    expect(() => render(<Buttons />)).toThrow('useToast must be used inside <ToastProvider>')
    window.removeEventListener('error', hush)
    spy.mockRestore()
  })

  it('has no accessibility violations with toasts showing', async () => {
    mount()
    await userEvent.click(screen.getByText('ok'))
    await userEvent.click(screen.getByText('fail'))
    await expectNoA11yViolations(document.body)
  })
})

describe('Modal: description for assistive technology', () => {
  it('is described by its body text, as well as named by its title', () => {
    render(
      <Modal open onClose={() => undefined} title="Stop it?">
        <p>This cannot be undone.</p>
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'Stop it?', description: 'This cannot be undone.' })).toHaveAttribute('aria-modal', 'true')
  })
})
