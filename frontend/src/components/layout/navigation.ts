import type { Role } from '../../api/types'
import type { IconName } from './icons'

export interface NavItem {
  to: string
  label: string
  icon: IconName
}

/** What each role can navigate to. (The backend still enforces who may read what.) */
export function navFor(role: Role): NavItem[] {
  if (role === 'patient') {
    return [
      { to: '/today', label: 'Today', icon: 'today' },
      { to: '/upcoming', label: 'Upcoming', icon: 'upcoming' },
      { to: '/medications', label: 'Medications', icon: 'medications' },
      { to: '/sharing', label: 'Sharing', icon: 'sharing' },
      { to: '/activity', label: 'Activity', icon: 'activity' },
    ]
  }
  return [
    { to: '/patients', label: 'Patients', icon: 'patients' },
    { to: '/invitations', label: 'Invitations', icon: 'invitations' },
  ]
}
