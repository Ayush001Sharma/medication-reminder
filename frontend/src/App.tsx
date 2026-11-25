import { Navigate, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './auth/ProtectedRoute'
import { homePathFor, useAuth } from './auth/context'
import { AppShell } from './components/layout/AppShell'
import { ForbiddenPage } from './pages/ForbiddenPage'
import { LoginPage } from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { RegisterPage } from './pages/RegisterPage'
import { InvitationsPage } from './pages/grantee/InvitationsPage'
import { PatientsPage } from './pages/grantee/PatientsPage'
import { ReportPage } from './pages/grantee/ReportPage'
import { ActivityPage } from './pages/patient/ActivityPage'
import { SharingPage } from './pages/patient/SharingPage'
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
            <Route path="/sharing" element={<SharingPage />} />
            <Route path="/activity" element={<ActivityPage />} />
          </Route>

          <Route element={<ProtectedRoute roles={['caregiver', 'doctor']} />}>
            <Route path="/patients" element={<PatientsPage />} />
            <Route path="/patients/:patientId" element={<ReportPage />} />
            <Route path="/invitations" element={<InvitationsPage />} />
          </Route>

          <Route path="/forbidden" element={<ForbiddenPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}
