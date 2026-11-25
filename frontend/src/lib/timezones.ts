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

/** The old names that now map to this zone. */
export function formerNames(zone: string): string[] {
  return Object.entries(RENAMED).filter(([, current]) => current === zone).map(([old]) => old)
}

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

export interface ZoneChoice {
  value: string
  /** "America/New York": underscores read as spaces. */
  label: string
  /** The current UTC offset, e.g. "GMT+5:30", so people can also search by offset. */
  detail: string
  /** Former names (Asia/Calcutta for Asia/Kolkata), searched but not shown. */
  keywords: string
}

let cachedChoices: ZoneChoice[] | null = null

function offsetOf(zone: string, now: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')
    return part?.value ?? ''
  } catch {
    return ''
  }
}

/** Every zone as a combobox option, computed once (looking up 400+ offsets is not free). */
export function timezoneChoices(now: Date = new Date()): ZoneChoice[] {
  cachedChoices ??= timezoneOptions().all.map((zone) => ({
    value: zone,
    label: zone.replaceAll('_', ' '),
    detail: offsetOf(zone, now),
    keywords: formerNames(zone).join(' '),
  }))
  return cachedChoices
}
