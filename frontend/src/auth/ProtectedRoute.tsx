import { Navigate, Outlet, useLocation } from 'react-router-dom'
import type { Role } from '../api/types'
import { Spinner } from '../components/ui/Spinner'
import { ForbiddenPage } from '../pages/ForbiddenPage'
import { useAuth } from './context'

/**
 * A layout route that guards everything nested inside it.
 *   <Route element={<ProtectedRoute />}>                       signed-in users only
 *   <Route element={<ProtectedRoute roles={['patient']} />}>   signed in AND one of these roles
 * Not signed in -> /login (remembering where you were going). Wrong role -> a 403 page.
 *
 * This only decides what the UI shows. The backend enforces the same rules on every request.
 */
export function ProtectedRoute({ roles }: { roles?: Role[] }) {
  const { status, user } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div role="status" className="flex min-h-[40vh] items-center justify-center gap-3 text-ink">
        <Spinner />
        <span>Loading your account…</span>
      </div>
    )
  }
  if (status !== 'authenticated' || !user) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
  }
  if (roles && !roles.includes(user.role)) return <ForbiddenPage />
  return <Outlet />
}
