/**
 * CountdownScreen — web-testing-only visible countdown UI.
 *
 * ⚠️  WEB TESTING CONCESSION — NOT the production design.
 * In production (Android TWA), the countdown runs as an invisible background
 * service; the visible timer and Cancel button are REMOVED in that phase.
 * See requirements §3 preamble and design.md §7.4.
 *
 * triggeredAt arrives as a Date in location.state — set at button-press time
 * in HomeScreen (Section 6 guardrail). useCountdown reads it here and calls
 * getCurrentPosition on mount (design §6.2); no Promise crosses the
 * navigation boundary.
 */
import { useEffect } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useCountdown } from '../hooks/useCountdown'
import { CircularTimer } from '../components/CircularTimer'

export function CountdownScreen() {
  const navigate  = useNavigate()
  const location  = useLocation()

  const state = location.state as {
    triggeredAt?: Date | string
    triggerType?: 'power_button' | 'earbud' | 'shake' | 'duress_phrase' | 'duress_pin'
  } | null
  const rawTs = state?.triggeredAt
  const triggerType = state?.triggerType ?? 'shake'

  const triggeredAt: Date = rawTs instanceof Date
    ? rawTs
    : typeof rawTs === 'string'
      ? new Date(rawTs)
      : new Date()

  const {
    secondsLeft, status, sessionId, locationWarning,
    error, cancel, acceptedGuardianCount, dispatchState, cancelBlocked,
    contactsNotified,
  } = useCountdown(triggeredAt, triggerType)

  // Auto-redirect after cancellation
  useEffect(() => {
    if (status === 'cancelled') {
      const id = setTimeout(() => navigate('/home', { replace: true }), 2000)
      return () => clearTimeout(id)
    }
  }, [status, navigate])

  // ── Error state ───────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="screen-centered" style={{ textAlign: 'center', gap: '1.5rem' }}>
        <p style={{ fontSize: '2.5rem' }}>❌</p>
        <h1 style={{ fontSize: '1.4rem' }}>Could not start emergency session</h1>
        <p className="text-muted">
          {error ?? 'Please try again or call emergency services directly.'}
        </p>
        <button className="btn btn-ghost" style={{ maxWidth: '240px' }} onClick={() => navigate('/home')}>
          Go back
        </button>
      </div>
    )
  }

  // ── Cancelled state ───────────────────────────────────────────────────────
  if (status === 'cancelled') {
    return (
      <div className="screen-centered" style={{ textAlign: 'center', gap: '1rem' }}>
        <p style={{ fontSize: '2.5rem' }}>✓</p>
        <h1 style={{ color: 'var(--accent-green-l)' }}>SOS cancelled.</h1>
        <p className="text-muted">Returning home…</p>
      </div>
    )
  }

  // ── SOS Active state ──────────────────────────────────────────────────────
  if (status === 'active') {
    return (
      <div className="screen-centered" style={{ textAlign: 'center', gap: '1.5rem', padding: '2rem' }}>
        <div style={{ fontSize: '3rem', animation: 'pulse 1.5s ease-in-out infinite' }}>🚨</div>
        <h1 style={{ color: 'var(--accent-red-l)', fontSize: '1.6rem' }}>SOS Active</h1>

        <p style={{ color: 'var(--text)', lineHeight: 1.7, maxWidth: '300px' }}>
          Help is on the way.<br />
          <span className="text-muted" style={{ fontSize: '0.875rem' }}>
            Nearby guardians and emergency contacts are being alerted.
          </span>
        </p>

        {/* Guardian dispatch status — derived from sosSessions.guardiansPinged / contactsNotified */}
        {acceptedGuardianCount > 0 && (
          <div className="banner banner-info" role="status" aria-live="polite"
            style={{ maxWidth: '300px', fontWeight: 600 }}>
            ✅ {acceptedGuardianCount === 1
              ? '1 guardian is on their way to you'
              : `${acceptedGuardianCount} guardians are on their way to you`}
          </div>
        )}

        {acceptedGuardianCount === 0 && dispatchState === 'searching' && (
          <p className="text-muted text-sm" style={{ maxWidth: '280px', lineHeight: 1.6 }}>
            🔍 Alerting nearby guardians…
          </p>
        )}

        {acceptedGuardianCount === 0 && dispatchState === 'guardians_pinged' && (
          <p className="text-muted text-sm" style={{ maxWidth: '280px', lineHeight: 1.6 }}>
            🔔 Nearby guardians have been alerted. Awaiting response…
          </p>
        )}

        {dispatchState === 'contacts_notified' && acceptedGuardianCount === 0 && (
          <div className="banner banner-warning" role="status" aria-live="polite"
            style={{ maxWidth: '300px' }}>
            No guardians were nearby. Your emergency contacts have been notified instead.
          </div>
        )}

        {/* Show "contacts also notified" in the guardian-found path — contacts are always
            notified when an SOS activates, so surface this as reassurance when a guardian
            was also dispatched. */}
        {contactsNotified && dispatchState !== 'contacts_notified' && (
          <div className="banner banner-info" role="status" aria-live="polite"
            style={{ maxWidth: '300px', fontSize: '0.875rem' }}>
            📲 Your emergency contacts have also been notified.
          </div>
        )}

        {dispatchState === 'no_response' && acceptedGuardianCount === 0 && (
          <div className="banner banner-warning" role="status" aria-live="polite"
            style={{ maxWidth: '300px' }}>
            No guardians or emergency contacts could be reached.
            Call emergency services directly if you need help.
          </div>
        )}

        {sessionId && (
          <p className="text-muted text-xs">Session: {sessionId.slice(0, 8)}…</p>
        )}

        {/* Cancel — shows clear message if session is already active and cannot be cancelled */}
        {cancelBlocked ? (
          <div className="banner banner-warning" role="alert" style={{ maxWidth: '300px' }}>
            Emergency response already dispatched — cancel is no longer possible.
            Tap "Add evidence" or wait for help to arrive.
          </div>
        ) : (
          <button
            id="late-cancel-btn"
            className="btn btn-ghost"
            style={{ maxWidth: '260px', marginTop: '0.5rem' }}
            onClick={() => void cancel()}
          >
            I'm safe — cancel now
          </button>
        )}

        {sessionId && (
          <Link
            to={`/evidence/capture?incidentId=${sessionId}`}
            className="btn btn-ghost"
            style={{ maxWidth: '260px', fontSize: '0.875rem' }}
            aria-label="Attach evidence to this incident"
          >
            📎 Add evidence to this incident
          </Link>
        )}

        {!cancelBlocked && (
          <p className="text-muted text-xs">
            (Cancel may fail if emergency response has already been dispatched.)
          </p>
        )}

        <style>{`
          @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50%       { transform: scale(1.15); }
          }
        `}</style>
      </div>
    )
  }

  // ── Pending / Countdown state ─────────────────────────────────────────────
  return (
    <div className="screen-centered" style={{ textAlign: 'center', gap: '1.5rem' }}>
      {status === 'pending' ? (
        <div className="spinner" role="status" aria-label="Starting SOS…" />
      ) : (
        <CircularTimer secondsLeft={secondsLeft} />
      )}

      {locationWarning && (
        <div className="banner banner-warning" role="alert" style={{ maxWidth: '320px' }}>
          📍 Location unavailable — guardians may not be notified.
        </div>
      )}

      <p style={{ fontSize: '1.1rem', fontWeight: 500, maxWidth: '280px', lineHeight: 1.6 }}>
        Stay calm.
        <br />
        <span className="text-muted" style={{ fontSize: '0.95rem', fontWeight: 400 }}>
          Nothing is visible to anyone watching.
        </span>
      </p>

      <button
        id="cancel-sos-btn"
        className="btn btn-danger-ghost"
        style={{ maxWidth: '220px' }}
        disabled={status === 'pending'}
        onClick={() => void cancel()}
      >
        Cancel SOS
      </button>

      <p className="text-muted text-xs" style={{ maxWidth: '280px', lineHeight: 1.6 }}>
        ⚠️ This visible timer is a web-testing concession.
        In production, the countdown is invisible and runs in the background.
      </p>
    </div>
  )
}
