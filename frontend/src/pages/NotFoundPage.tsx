import { homePathFor, useAuth } from '../auth/context'
import { ButtonLink } from '../components/ui/ButtonLink'
import { EmptyState } from '../components/ui/EmptyState'

export function NotFoundPage() {
  const { user } = useAuth()
  return (
    <EmptyState
      headingAs="h1"
      title="We could not find that page"
      description="The link may be out of date, or the page may have moved."
      action={<ButtonLink to={user ? homePathFor(user.role) : '/login'}>{user ? 'Go to my home page' : 'Go to sign in'}</ButtonLink>}
    />
  )
}
