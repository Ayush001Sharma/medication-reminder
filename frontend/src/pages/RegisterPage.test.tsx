import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { expectNoA11yViolations } from '../test/axe'
import type { AuthValue } from '../auth/context'
import { authValue, makeUser, renderWithProviders } from '../test/helpers'
import { RegisterPage } from './RegisterPage'

function renderRegister(register: AuthValue['register']) {
  return renderWithProviders(
    <Routes>
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/today" element={<p>Today page</p>} />
      <Route path="/patients" element={<p>Patients page</p>} />
    </Routes>,
    { route: '/register', auth: authValue(null, { register }) },
  )
}

const detected = Intl.DateTimeFormat().resolvedOptions().timeZone

describe('RegisterPage', () => {
  it('registers a patient with their timezone, defaulting to the browser timezone', async () => {
    const register = vi.fn<AuthValue['register']>().mockResolvedValue(makeUser('patient'))
    renderRegister(register)
    expect(screen.getByLabelText('Your timezone')).toHaveValue(detected)
    await userEvent.type(screen.getByLabelText('Full name'), ' Asha Patel ')
    await userEvent.type(screen.getByLabelText('Email'), 'asha@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-password')
    await userEvent.selectOptions(screen.getByLabelText('Your timezone'), 'Asia/Kolkata')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(register).toHaveBeenCalledWith({
      fullName: 'Asha Patel',
      email: 'asha@example.com',
      password: 'a-long-password',
      role: 'patient',
      timezone: 'Asia/Kolkata',
    })
    expect(await screen.findByText('Today page')).toBeInTheDocument()
  })

  it('only asks for a timezone when registering as a patient', async () => {
    renderRegister(vi.fn<AuthValue['register']>())
    expect(screen.getByLabelText('Your timezone')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('I am a'), 'doctor')
    expect(screen.queryByLabelText('Your timezone')).not.toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('I am a'), 'patient')
    expect(screen.getByLabelText('Your timezone')).toBeInTheDocument()
  })

  it('sends a caregiver to the patients page', async () => {
    renderRegister(vi.fn<AuthValue['register']>().mockResolvedValue(makeUser('caregiver')))
    await userEvent.type(screen.getByLabelText('Email'), 'c@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-password')
    await userEvent.selectOptions(screen.getByLabelText('I am a'), 'caregiver')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Patients page')).toBeInTheDocument()
  })

  it('shows the server\'s field errors next to the right fields', async () => {
    const error = new ApiError(400, 'A user with this email already exists.', {
      email: ['A user with this email already exists.'],
      password: ['This password is too common.'],
    })
    renderRegister(vi.fn<AuthValue['register']>().mockRejectedValue(error))
    await userEvent.type(screen.getByLabelText('Email'), 'taken@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('A user with this email already exists.')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(/too common/)
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled()
  })

  it('shows a general message for errors that are not about a field', async () => {
    renderRegister(vi.fn<AuthValue['register']>().mockRejectedValue(new ApiError(429, 'Too many attempts. Please wait 60 seconds and try again.', undefined, 60)))
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('wait 60 seconds')
  })

  it('has no accessibility violations', async () => {
    const { container } = renderRegister(vi.fn<AuthValue['register']>())
    await expectNoA11yViolations(container)
  })
})
