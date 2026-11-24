/** The parts of the backend's JSON that the frontend uses. */
export type Role = 'patient' | 'caregiver' | 'doctor'

export interface PatientProfile {
  timezone: string
  phone_number: string
  notification_preferences: Record<string, boolean>
}

export interface Me {
  id: number
  email: string
  full_name: string
  role: Role
  patient_profile?: PatientProfile | null
}

export interface TokenPair {
  access: string
  refresh: string
}

export type DoseStatus = 'pending' | 'reminded' | 'taken' | 'missed' | 'skipped'

export interface Dose {
  id: number
  medication: { id: number; name: string; dosage: string; instructions: string }
  scheduled_at: string
  /** ISO 8601 in the patient's own timezone, e.g. 2026-11-25T08:00:00+05:30 */
  scheduled_local: string
  status: DoseStatus
  taken_late: boolean
  taken_at: string | null
}

export interface AdherenceTotals {
  total: number
  taken: number
  taken_late: number
  missed: number
  skipped: number
  adherence_percent: number | null
}

export interface AdherenceReport {
  totals: AdherenceTotals
  current_streak: number
  range: { from: string; to: string; timezone: string }
}

export interface AccessiblePatient {
  id: number
  email: string
  full_name: string
  timezone: string
}
