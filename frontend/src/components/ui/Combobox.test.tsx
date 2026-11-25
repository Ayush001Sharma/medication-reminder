import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoA11yViolations } from '../../test/axe'
import { Combobox, type ComboboxOption } from './Combobox'

const options: ComboboxOption[] = [
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata', detail: 'GMT+5:30' },
  { value: 'America/New_York', label: 'America/New York', detail: 'GMT-5' },
  { value: 'America/Los_Angeles', label: 'America/Los Angeles', detail: 'GMT-8' },
  { value: 'Europe/London', label: 'Europe/London', detail: 'GMT' },
]

function Harness({ initial = 'Europe/London', onSubmit = vi.fn(), error }: { initial?: string; onSubmit?: () => void; error?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <form onSubmit={(event) => { event.preventDefault(); onSubmit() }}>
      <Combobox label="Timezone" options={options} value={value} onChange={setValue} error={error} hint="Type to search." emptyText="Nothing matches" />
      <output data-testid="value">{value}</output>
      <button type="submit">Save</button>
    </form>
  )
}

const box = () => screen.getByRole('combobox', { name: 'Timezone' })
const chosen = () => screen.getByTestId('value').textContent

describe('Combobox', () => {
  it('shows the current choice and stays closed until used', () => {
    render(<Harness />)
    expect(box()).toHaveValue('Europe/London')
    expect(box()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('opens on click and lists every option with its detail', async () => {
    render(<Harness />)
    await userEvent.click(box())
    expect(box()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.getByRole('option', { name: /Asia\/Kolkata/ })).toHaveTextContent('GMT+5:30')
    expect(screen.getByRole('option', { name: /Europe\/London/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('filters as you type, ignoring case, underscores and slashes', async () => {
    render(<Harness />)
    await userEvent.click(box())
    await userEvent.keyboard('{Control>}a{/Control}new york')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['America/New YorkGMT-5'])
    await userEvent.keyboard('{Control>}a{/Control}ASIA/KOL')
    expect(screen.getByRole('option', { name: /Asia\/Kolkata/ })).toBeInTheDocument()
  })

  it('finds an option by a hidden keyword (a former name) without showing it', async () => {
    const withKeyword = options.map((o) => (o.value === 'Asia/Kolkata' ? { ...o, keywords: 'Asia/Calcutta' } : o))
    render(<Combobox label="Timezone" options={withKeyword} value="Europe/London" onChange={() => undefined} />)
    await userEvent.click(box())
    await userEvent.keyboard('{Control>}a{/Control}calcutta')
    const found = screen.getAllByRole('option')
    expect(found).toHaveLength(1)
    expect(found[0]).toHaveTextContent('Asia/Kolkata')
    expect(found[0]).not.toHaveTextContent('Calcutta')
  })

  it('also finds a zone by its UTC offset', async () => {
    render(<Harness />)
    await userEvent.click(box())
    await userEvent.keyboard('{Control>}a{/Control}+5:30')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Kolkata/ })).toBeInTheDocument()
  })

  it('says so when nothing matches, and offers no options', async () => {
    render(<Harness />)
    await userEvent.click(box())
    await userEvent.keyboard('{Control>}a{/Control}atlantis')
    expect(screen.getByText('Nothing matches')).toHaveAttribute('role', 'status') // announced to screen readers
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('chooses with the mouse', async () => {
    render(<Harness />)
    await userEvent.click(box())
    await userEvent.click(screen.getByRole('option', { name: /Los Angeles/ }))
    expect(chosen()).toBe('America/Los_Angeles')
    expect(box()).toHaveValue('America/Los Angeles')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('works from the keyboard: arrows move, Enter chooses, aria-activedescendant follows', async () => {
    render(<Harness initial="Asia/Kolkata" />)
    await userEvent.click(box())
    await userEvent.keyboard('{Control>}a{/Control}america')
    const [first, second] = screen.getAllByRole('option')
    expect(box()).toHaveAttribute('aria-activedescendant', first?.id)
    await userEvent.keyboard('{ArrowDown}')
    expect(box()).toHaveAttribute('aria-activedescendant', second?.id)
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowDown}')
    await userEvent.keyboard('{Enter}')
    expect(chosen()).toBe('America/Los_Angeles')
  })

  it('ArrowDown opens a closed list', async () => {
    render(<Harness />)
    box().focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(box()).toHaveAttribute('aria-expanded', 'true')
  })

  it('Enter while open chooses and does NOT submit the form; Enter while closed submits', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await userEvent.click(box())
    await userEvent.keyboard('kolkata{Enter}')
    expect(chosen()).toBe('Asia/Kolkata')
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('Escape closes and discards half-typed text', async () => {
    render(<Harness />)
    await userEvent.click(box())
    await userEvent.keyboard('{Control>}a{/Control}kol')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(box()).toHaveValue('Europe/London')
    expect(chosen()).toBe('Europe/London')
  })

  it('leaving the field with half-typed text restores the choice instead of inventing a value', async () => {
    render(<Harness />)
    await userEvent.click(box())
    await userEvent.keyboard('{Control>}a{/Control}Moon base')
    await userEvent.tab()
    expect(box()).toHaveValue('Europe/London')
    expect(chosen()).toBe('Europe/London')
  })

  it('connects hint and error to the field and marks it invalid', () => {
    render(<Harness error="Not a valid time zone." />)
    expect(box()).toHaveAttribute('aria-invalid', 'true')
    expect(box()).toHaveAccessibleDescription('Type to search. Not a valid time zone.')
  })

  it('has no accessibility violations, open or closed', async () => {
    const { container } = render(<Harness />)
    await expectNoA11yViolations(container)
    await userEvent.click(box())
    await expectNoA11yViolations(container)
  })
})
