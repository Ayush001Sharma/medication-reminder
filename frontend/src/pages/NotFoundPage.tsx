import { homePathFor, useAuth } from '../auth/context'
import { ButtonLink } from '../components/ui/ButtonLink'
import { EmptyState } from '../components/ui/EmptyState'
import { usePageTitle } from '../hooks/usePageTitle'

export function NotFoundPage() {
  usePageTitle('Page not found')
  const { user } = useAuth()
  return (
    <EmptyState
      headingAs="h1"
      title="We could not find that page"
      description="The link may be out of date, or the page may have moved."
      action={<ButtonLink to={user ? homePathFor(user.role) : '/'}>{user ? 'Go to my home page' : 'Go to the start page'}</ButtonLink>}
    />
  )
}
