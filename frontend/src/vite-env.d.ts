/// <reference types="vite/client" />

/** The build-time variables the app reads (see .env.example). All optional: the app works without any of them. */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  /** Exactly "true" turns demo mode on; any other value (or none) leaves it off and out of the build. */
  readonly VITE_DEMO_MODE?: string
  readonly VITE_DEMO_PASSWORD?: string
  readonly VITE_DEMO_PATIENT_KOLKATA_EMAIL?: string
  readonly VITE_DEMO_PATIENT_NEW_YORK_EMAIL?: string
  readonly VITE_DEMO_CAREGIVER_EMAIL?: string
  readonly VITE_DEMO_DOCTOR_EMAIL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
