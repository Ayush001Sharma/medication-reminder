import { Navigate, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './auth/ProtectedRoute'
import { homePathFor, useAuth } from './auth/context'
import { AppShell } from './components/layout/AppShell'
import { ForbiddenPage } from './pages/ForbiddenPage'
import { LoginPage } from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { RegisterPage } from './pages/RegisterPage'
import { PatientsPage } from './pages/grantee/PatientsPage'
import { EditMedicationPage, NewMedicationPage } from './pages/patient/MedicationFormPages'
import { MedicationsPage } from './pages/patient/MedicationsPage'
import { TodayPage } from './pages/patient/TodayPage'
import { UpcomingPage } from './pages/patient/UpcomingPage'

/** "/" sends you where your role starts, or to sign-in. */
function HomeRedirect() {
  const { status, user } = useAuth()
  if (status === 'loading') return null
  return <Navigate to={user ? homePathFor(user.role) : '/login'} replace />
}

export function App() {
  return (
    <Routes>
      <Route index element={<HomeRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* Everything below needs a signed-in user and gets the app shell. */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route element={<ProtectedRoute roles={['patient']} />}>
            <Route path="/today" element={<TodayPage />} />
            <Route path="/upcoming" element={<UpcomingPage />} />
            <Route path="/medications" element={<MedicationsPage />} />
            <Route path="/medications/new" element={<NewMedicationPage />} />
            <Route path="/medications/:id/edit" element={<EditMedicationPage />} />
            <Route
              path="/sharing"
              element={<PlaceholderPage title="Sharing" icon="sharing" description="Invite a caregiver or doctor and choose who can see your reports." />}
            />
            <Route
              path="/activity"
              element={<PlaceholderPage title="Activity" icon="activity" description="See who has viewed your adherence information." />}
            />
          </Route>

          <Route element={<ProtectedRoute roles={['caregiver', 'doctor']} />}>
            <Route path="/patients" element={<PatientsPage />} />
            <Route
              path="/invitations"
              element={<PlaceholderPage title="Invitations" icon="invitations" description="Accept invitations from patients who want to share their reports with you." />}
            />
          </Route>

          <Route path="/forbidden" element={<ForbiddenPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
