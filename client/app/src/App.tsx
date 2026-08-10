import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { RequireAuth } from './components/RequireAuth'
import { LoginScreen }           from './screens/LoginScreen'
import { HomeScreen }            from './screens/HomeScreen'
import { SetupScreen }           from './screens/SetupScreen'
import { CountdownScreen }       from './screens/CountdownScreen'
import { GuardianInboxScreen }   from './screens/GuardianInboxScreen'
import { GuardianHistoryScreen } from './screens/GuardianHistoryScreen'
import { EvidenceCaptureScreen } from './screens/EvidenceCaptureScreen'
import { EvidenceTimelineScreen } from './screens/EvidenceTimelineScreen'
import { LegalExportScreen }     from './screens/LegalExportScreen'

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginScreen />} />

            {/* Protected routes */}
            <Route element={<RequireAuth />}>
              <Route path="/"                element={<Navigate to="/home" replace />} />
              <Route path="/home"            element={<HomeScreen />} />
              <Route path="/setup"           element={<SetupScreen />} />
              <Route path="/countdown"       element={<CountdownScreen />} />
              <Route path="/guardian-inbox"   element={<GuardianInboxScreen />} />
              <Route path="/guardian-history" element={<GuardianHistoryScreen />} />

              {/* Evidence Trail */}
              <Route path="/evidence/capture"               element={<EvidenceCaptureScreen />} />
              <Route path="/incidents/:incidentId/evidence" element={<EvidenceTimelineScreen />} />
              <Route path="/incidents/:incidentId/export"   element={<LegalExportScreen />} />
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  )
}
