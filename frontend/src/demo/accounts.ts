/**
 * The demo accounts, exactly as `python manage.py seed_demo` creates them (see the README's seed section and
 * accounts/management/commands/seed_demo.py). The defaults below match that command; .env.example lists the same
 * values so a different seed (`--password`, `DEMO_PASSWORD`) can be mirrored without editing code.
 *
 * Only the demo chunk imports this file, and that chunk exists only in a build made with VITE_DEMO_MODE=true.
 * This is a LOCAL DEVELOPMENT convenience: never enable it against a real backend.
 */
export interface DemoAccount {
  id: 'patient-kolkata' | 'patient-new-york' | 'caregiver' | 'doctor'
  /** The button text. */
  label: string
  email: string
}

const env = import.meta.env

export const DEMO_PASSWORD: string = env.VITE_DEMO_PASSWORD || 'demo-password-123'

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { id: 'patient-kolkata', label: 'Try as patient (Kolkata)', email: env.VITE_DEMO_PATIENT_KOLKATA_EMAIL || 'demo.asha@example.com' },
  { id: 'patient-new-york', label: 'Try as patient (New York)', email: env.VITE_DEMO_PATIENT_NEW_YORK_EMAIL || 'demo.ben@example.com' },
  { id: 'caregiver', label: 'Try as caregiver', email: env.VITE_DEMO_CAREGIVER_EMAIL || 'demo.carla@example.com' },
  { id: 'doctor', label: 'Try as doctor', email: env.VITE_DEMO_DOCTOR_EMAIL || 'demo.dr.rao@example.com' },
]
