import { BrowserRouter, Routes, Route, Navigate, useLocation, Outlet } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { RequireAuth } from './components/RequireAuth'
import { useAuth } from './contexts/AuthContext'
import { LoginScreen }            from './screens/LoginScreen'
import { PinScreen }              from './screens/PinScreen'
import { HomeScreen }             from './screens/HomeScreen'
import { SetupScreen }            from './screens/SetupScreen'
import { CountdownScreen }        from './screens/CountdownScreen'
import { GuardianInboxScreen }    from './screens/GuardianInboxScreen'
import { GuardianHistoryScreen }  from './screens/GuardianHistoryScreen'
import { EvidenceCaptureScreen }  from './screens/EvidenceCaptureScreen'
import { EvidenceTimelineScreen } from './screens/EvidenceTimelineScreen'
import { LegalExportScreen }      from './screens/LegalExportScreen'
import { SettingsScreen }         from './screens/SettingsScreen'
import { OnboardingScreen }       from './screens/OnboardingScreen'
import { TrustedContactsScreen }  from './screens/TrustedContactsScreen'

/**
 * RequirePin — redirects to /pin if PIN lock is enabled and app is not yet unlocked.
 * Used as a React Router layout route (renders <Outlet /> on pass).
 */
function RequirePin() {
  const { pinLockEnabled, isUnlocked } = useAuth()
  const location = useLocation()

  if (pinLockEnabled && !isUnlocked) {
    return <Navigate to="/pin" state={{ from: location }} replace />
  }
  return <Outlet />
}

/**
 * RequireOnboarding — redirects first-run victim users to /onboarding
 * before showing /home. Only fires when onboardingComplete is false and
 * the user is landing on /home (not guardian-inbox or other routes).
 */
function RequireOnboarding() {
  const { onboardingComplete, loading } = useAuth()
  const location = useLocation()

  // Don't flash the wrong screen while auth resolves
  if (loading) return null

  if (!onboardingComplete && location.pathname === '/home') {
    return <Navigate to="/onboarding" replace />
  }
  return <Outlet />
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginScreen />} />

            {/* PIN screen — authenticated but not yet unlocked.
                Not inside RequireAuth wrapper because the user IS auth'd when
                they reach it — they just haven't entered their PIN yet. */}
            <Route path="/pin" element={<PinScreen />} />

            {/* Protected routes — require Firebase auth AND PIN unlock */}
            <Route element={<RequireAuth />}>
              <Route element={<RequirePin />}>
                <Route path="/"                element={<Navigate to="/home" replace />} />

                {/* /home has an extra onboarding guard for first-run victims */}
                <Route element={<RequireOnboarding />}>
                  <Route path="/home" element={<HomeScreen />} />
                </Route>

                <Route path="/setup"           element={<SetupScreen />} />
                <Route path="/countdown"       element={<CountdownScreen />} />
                <Route path="/guardian-inbox"   element={<GuardianInboxScreen />} />
                <Route path="/guardian-history" element={<GuardianHistoryScreen />} />

                {/* Onboarding, Settings, Trusted Contacts */}
                <Route path="/onboarding"                  element={<OnboardingScreen />} />
                <Route path="/settings"                    element={<SettingsScreen />} />
                <Route path="/settings/trusted-contacts"   element={<TrustedContactsScreen />} />

                {/* Evidence Trail */}
                <Route path="/evidence/capture"               element={<EvidenceCaptureScreen />} />
                <Route path="/incidents/:incidentId/evidence" element={<EvidenceTimelineScreen />} />
                <Route path="/incidents/:incidentId/export"   element={<LegalExportScreen />} />
              </Route>
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  )
}
