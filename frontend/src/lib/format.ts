/** "08:00" from an ISO timestamp that is already in the patient's local time (2026-11-25T08:00:00+05:30). */
export function localTime(isoLocal: string): string {
  return isoLocal.slice(11, 16)
}

export function firstName(fullName: string, email: string): string {
  return fullName.trim().split(/\s+/)[0] || email.split('@')[0] || email
}
