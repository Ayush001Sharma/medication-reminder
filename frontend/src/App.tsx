import { Navigate, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './auth/ProtectedRoute'
import { homePathFor, useAuth } from './auth/context'
import { AppShell } from './components/layout/AppShell'
import { Logo } from './components/layout/Logo'
import { ButtonLink } from './components/ui/ButtonLink'
import { ForbiddenPage } from './pages/ForbiddenPage'
import { LandingPage } from './pages/LandingPage'
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

/** "/" is the welcome page for visitors; someone who is already signed in goes straight to where their role starts. */
function HomeRoute() {
  const { status, user } = useAuth()
  if (status === 'loading') return null
  return user ? <Navigate to={homePathFor(user.role)} replace /> : <LandingPage />
}

/** An unknown address: inside the app shell for signed-in people, on a plain page for visitors. Never a blank screen. */
function NotFoundRoute() {
  const { status, user } = useAuth()
  if (status === 'loading') return null
  if (user) {
    return (
      <AppShell>
        <NotFoundPage />
      </AppShell>
    )
  }
  return (
    <div className="min-h-dvh bg-cream text-ink">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <Logo />
        <ButtonLink to="/login" variant="ghost" size="md">
          Sign in
        </ButtonLink>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-10">
        <NotFoundPage />
      </main>
    </div>
  )
}

export function App() {
  return (
    <Routes>
      <Route index element={<HomeRoute />} />
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
        </Route>
      </Route>
      <Route path="*" element={<NotFoundRoute />} />
    </Routes>
  )
}
