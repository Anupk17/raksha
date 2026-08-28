/**
 * SettingsScreen — central hub for app configuration.
 *
 * Links to: trigger setup, trusted contacts, and the onboarding guide.
 * Accessible from HomeScreen nav bar.
 *
 * Design: §Change 5 — Settings Screen
 */
import { useNavigate, Link } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../firebase'
import { useAuth } from '../contexts/AuthContext'

export function SettingsScreen() {
  const navigate = useNavigate()
  const { lockApp } = useAuth()

  return (
    <div className="screen">
      <nav className="nav-bar">
        <span className="nav-logo">🛡️ RAKSHA</span>
        <div className="nav-links">
          <Link to="/home" className="nav-link">Home</Link>
          <button
            className="btn btn-ghost btn-sm"
            style={{ width: 'auto' }}
            onClick={() => { lockApp(); void signOut(auth) }}
          >
            Sign out
          </button>
        </div>
      </nav>

      <h1 style={{ marginBottom: '0.25rem' }}>Settings</h1>
      <p className="text-muted text-sm" style={{ marginBottom: '1.75rem' }}>
        Configure your RAKSHA protection setup.
      </p>

      <div className="stack">
        {/* Trigger configuration */}
        <button
          className="card"
          onClick={() => navigate('/setup')}
          style={{ textAlign: 'left', cursor: 'pointer', width: '100%' }}
          aria-label="Configure silent activation triggers"
        >
          <div className="row-between">
            <div>
              <p style={{ fontWeight: 600, marginBottom: '0.2rem' }}>🎯 Configure triggers</p>
              <p className="text-muted text-sm">Shake, Duress PIN, App Lock PIN</p>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: '1.2rem' }}>›</span>
          </div>
        </button>

        {/* Trusted contacts */}
        <button
          className="card"
          onClick={() => navigate('/settings/trusted-contacts')}
          style={{ textAlign: 'left', cursor: 'pointer', width: '100%' }}
          aria-label="Manage trusted contacts"
        >
          <div className="row-between">
            <div>
              <p style={{ fontWeight: 600, marginBottom: '0.2rem' }}>👥 Trusted contacts</p>
              <p className="text-muted text-sm">Notified when no guardian is nearby</p>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: '1.2rem' }}>›</span>
          </div>
        </button>

        {/* Re-trigger onboarding */}
        <button
          className="card"
          onClick={() => navigate('/onboarding')}
          style={{ textAlign: 'left', cursor: 'pointer', width: '100%' }}
          aria-label="Revisit the setup guide"
        >
          <div className="row-between">
            <div>
              <p style={{ fontWeight: 600, marginBottom: '0.2rem' }}>📋 Setup guide</p>
              <p className="text-muted text-sm">Revisit the first-run setup walkthrough</p>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: '1.2rem' }}>›</span>
          </div>
        </button>
      </div>
    </div>
  )
}
