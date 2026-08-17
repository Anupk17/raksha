/**
 * GuardianInboxScreen — pending pings for a verified guardian.
 *
 * Changes from original:
 *  - Destructures onDuty from useGuardianPings
 *  - Nav bar: "History" link added
 *  - Duty badge: green "On duty" / amber "Off duty" based on onDuty field
 *  - Dev-only banner (VITE_USE_EMULATOR=true) with "Seed guardian at my
 *    location" button — updates /guardians/{uid}.currentLocation so
 *    proximity matching works when the device's real GPS differs from the
 *    Bengaluru default seeded by quickFill.
 *
 * Per requirements §4: verifies guardian status on mount, then streams
 * pending guardian_pings via onSnapshot. Firestore Timestamp → Date
 * conversion is done inside useGuardianPings (Section 6 guardrail).
 */
import { signOut } from 'firebase/auth'
import { Link } from 'react-router-dom'
import { doc, setDoc } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { useAuth } from '../contexts/AuthContext'
import { useGuardianPings } from '../hooks/useGuardianPings'
import { PingCard } from '../components/PingCard'

const IS_EMU = import.meta.env.VITE_USE_EMULATOR === 'true'

export function GuardianInboxScreen() {
  const { user } = useAuth()
  const uid = user!.uid

  const { guardianStatus, pings, loading, error, onDuty } = useGuardianPings(uid)

  // ── Dev-only: update guardian location to real device GPS ────────────────
  // Uses high-accuracy GPS with a longer timeout to get a proper fix, not
  // the browser's inaccurate WiFi-based location estimate.
  async function handleSeedLocation() {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await setDoc(doc(db, 'guardians', uid), {
            currentLocation: {
              latitude:  pos.coords.latitude,
              longitude: pos.coords.longitude,
            },
            lastLocationUpdate: new Date(),
          }, { merge: true })
          console.log('[GuardianInbox] Location seeded:', pos.coords.latitude, pos.coords.longitude, 'accuracy:', pos.coords.accuracy, 'm')
        } catch (err) {
          console.error('[GuardianInbox] Failed to seed location:', err)
        }
      },
      (err) => console.error('[GuardianInbox] Geolocation error:', err),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }, // maximumAge:0 forces fresh GPS, not cached WiFi fix
    )
  }

  return (
    <div className="screen">
      {/* Nav */}
      <nav className="nav-bar">
        <span className="nav-logo">🛡️ RAKSHA</span>
        <div className="nav-links">
          <Link to="/guardian-history" className="nav-link">History</Link>
          <Link to="/home" className="nav-link">Home</Link>
          <button
            className="btn btn-ghost btn-sm"
            style={{ width: 'auto' }}
            onClick={() => void signOut(auth)}
          >
            Sign out
          </button>
        </div>
      </nav>

      <div className="row-between" style={{ marginBottom: '1.5rem' }}>
        <h1>Guardian Inbox</h1>
        {guardianStatus === 'verified' && (
          onDuty
            ? <span className="chip chip-green">● On duty</span>
            : <span className="chip chip-amber">● Off duty</span>
        )}
      </div>

      {/* Error banner (onSnapshot errors) */}
      {error && (
        <div className="banner banner-error" role="alert" style={{ marginBottom: '1rem' }}>
          {error} — please reload.
        </div>
      )}

      {/* Dev-only: location seeding banner ─────────────────────────────────
          Visible only in emulator mode for verified guardians. Explains the
          Bengaluru default and lets the developer reseed to their real GPS
          so onSOSSessionUpdate's proximity rings can match. Hidden in prod. */}
      {IS_EMU && guardianStatus === 'verified' && (
        <div className="banner banner-warning" role="note" style={{ marginBottom: '1rem' }}>
          <p className="text-sm" style={{ marginBottom: '0.5rem' }}>
            🔧 Dev: Guardian location seeds from GPS on first login. If pings aren't
            appearing, tap below to force-reseed to your current location.
          </p>
          <button
            className="btn btn-ghost"
            style={{ padding: '0.4rem 0.75rem', fontSize: '0.875rem', width: 'auto' }}
            onClick={() => void handleSeedLocation()}
          >
            Seed guardian at my location
          </button>
        </div>
      )}

      {/* Loading skeleton — shown max 3s then replaced by actual content */}
      {loading && (
        <div className="stack">
          {[1, 2].map((i) => (
            <div key={i} className="card" style={{ height: '140px' }}>
              <div className="skeleton" style={{ height: '1rem', width: '60%', marginBottom: '0.75rem' }} />
              <div className="skeleton" style={{ height: '1rem', width: '40%', marginBottom: '1.5rem' }} />
              <div className="skeleton" style={{ height: '2.5rem' }} />
            </div>
          ))}
        </div>
      )}

      {/* Not registered */}
      {!loading && guardianStatus === 'not-registered' && (
        <div className="card" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
          <p style={{ fontSize: '2rem', marginBottom: '1rem' }}>🔒</p>
          <h2 style={{ marginBottom: '0.5rem' }}>Not a verified guardian</h2>
          <p className="text-muted" style={{ lineHeight: 1.7 }}>
            You are not registered as a verified RAKSHA Guardian.
            Contact support to apply.
          </p>
        </div>
      )}

      {/* Empty state */}
      {!loading && guardianStatus === 'verified' && pings.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
          <p style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>✓</p>
          <h2 style={{ marginBottom: '0.5rem' }}>No active pings</h2>
          <p className="text-muted">You're on standby. Alerts will appear here in real time.</p>
        </div>
      )}

      {/* Ping list */}
      {!loading && guardianStatus === 'verified' && pings.length > 0 && (
        <div className="stack">
          <p className="text-muted text-sm" style={{ marginBottom: '0.25rem' }}>
            {pings.length} pending alert{pings.length !== 1 ? 's' : ''}
          </p>
          {pings.map((ping) => (
            <PingCard key={ping.pingId} ping={ping} />
          ))}
        </div>
      )}
    </div>
  )
}
