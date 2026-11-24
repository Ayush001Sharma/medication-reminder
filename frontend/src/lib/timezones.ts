/**
 * Timezone choices for the register form.
 *
 * Browsers report some zones under an old name (ICU still says Asia/Calcutta, Europe/Kiev...). The backend
 * accepts those, but people expect the current IANA names and the rest of the app uses them, so legacy names
 * are renamed here. Only names that IANA renamed are listed.
 */
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka',
  'Europe/Kiev': 'Europe/Kyiv',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Truk': 'Pacific/Chuuk',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
}

const FALLBACK = ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney']

export function canonicalZone(name: string): string {
  return RENAMED[name] ?? name
}

/** Every zone the browser knows, under current names, sorted, plus the browser's own zone as the default. */
export function timezoneOptions(): { all: string[]; detected: string } {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : FALLBACK
  const detected = canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const all = [...new Set(['UTC', detected, ...supported.map(canonicalZone)])].sort((a, b) => a.localeCompare(b))
  return { all, detected }
}
