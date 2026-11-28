import { homePathFor, useAuth } from '../auth/context'
import { ButtonLink } from '../components/ui/ButtonLink'
import { EmptyState } from '../components/ui/EmptyState'
import { usePageTitle } from '../hooks/usePageTitle'

export function ForbiddenPage() {
  usePageTitle('Not available')
  const { user } = useAuth()
  return (
    <EmptyState
      headingAs="h1"
      title="This page is not available to your account"
      description="Your role does not include access to this area. If you think that is a mistake, ask the person who invited you."
      action={<ButtonLink to={user ? homePathFor(user.role) : '/login'}>Go to my home page</ButtonLink>}
    />
  )
}
