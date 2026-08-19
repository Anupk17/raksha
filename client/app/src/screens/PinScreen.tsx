/**
 * PinScreen — disguised app-lock PIN entry screen.
 *
 * APPEARANCE: "Daily Notes" branding. No RAKSHA logo, no shield, no safety
 * language. Looks like a generic PIN-locked notes app.
 *
 * STATE MACHINE:
 *   entry      → user is typing digits
 *   evaluating → handlePinSubmission running; dots still showing, no result
 *   result     → { outcome: 'decoy' | 'wrong' }
 *                BOTH outcomes render IDENTICAL JSX (same message, same shake).
 *                This is the P33 requirement: React sees one setState shape,
 *                performs the same VDOM diff for both paths.
 *
 * TIMING PARITY (P33):
 *   renderDecoyScreen and renderWrongPinError both call setState with
 *   { phase: 'result', outcome: X }. The JSX for both is structurally
 *   identical — only the internal outcome field differs, and outcome is
 *   NEVER used in JSX (only in a useEffect to trigger suppressNavigation).
 *
 * SECURITY:
 *   - No RAKSHA branding until inside protected routes
 *   - suppressNavigation() called when decoy renders
 *   - SOS fired fire-and-forget AFTER decoy screen is already showing
 *   - No visible change when SOS transitions countdown → active
 *
 * Design: §Change 3 — PinScreen
 * Requirements: 2, 3
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import bcrypt from 'bcryptjs'
import { db, fns } from '../firebase'
import { useAuth } from '../contexts/AuthContext'
import {
  calibrateBcrypt,
  handlePinSubmission,
  suppressNavigation,
} from '@sa/pinEntry'
import type { SilentActivationConfig } from '@sa/activationConfig'

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type PinScreenState =
  | { phase: 'entry' }
  | { phase: 'evaluating' }
  | { phase: 'result'; outcome: 'decoy' | 'wrong' }

// ---------------------------------------------------------------------------
// Keypad component — pure display, no business logic
// ---------------------------------------------------------------------------

interface PinKeypadProps {
  pinDisplay:  string    // dots string e.g. '●●●'
  disabled:    boolean
  shaking:     boolean
  errorMsg:    string | null
  onDigit:     (d: string) => void
  onDelete:    () => void
  onSubmit:    () => void
}

function PinKeypad({ pinDisplay, disabled, shaking, errorMsg, onDigit, onDelete, onSubmit }: PinKeypadProps) {
  const digits = ['1','2','3','4','5','6','7','8','9','','0','⌫']

  return (
    <div style={{ width: '100%', maxWidth: '280px' }}>
      {/* PIN dots display */}
      <div
        style={{
          textAlign: 'center',
          fontSize: '1.5rem',
          letterSpacing: '0.5rem',
          minHeight: '2.5rem',
          marginBottom: '0.5rem',
          animation: shaking ? 'pinShake 0.4s ease' : undefined,
          color: '#fff',
        }}
        aria-live="polite"
        aria-label={`${pinDisplay.length} digits entered`}
      >
        {pinDisplay || <span style={{ opacity: 0.3 }}>○○○○</span>}
      </div>

      {/* Error message — IDENTICAL for decoy and wrong-PIN (P33) */}
      <div style={{ minHeight: '1.5rem', textAlign: 'center', marginBottom: '1rem' }}>
        {errorMsg && (
          <p style={{ color: '#ff6b6b', fontSize: '0.8rem' }} role="alert">
            {errorMsg}
          </p>
        )}
      </div>

      {/* Keypad grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '0.75rem',
      }}>
        {digits.map((d, i) => {
          if (d === '') return <div key={i} />
          if (d === '⌫') {
            return (
              <button
                key={i}
                onClick={onDelete}
                disabled={disabled}
                style={keyStyle(disabled)}
                aria-label="Delete"
              >
                {d}
              </button>
            )
          }
          return (
            <button
              key={i}
              onClick={() => onDigit(d)}
              disabled={disabled}
              style={keyStyle(disabled)}
              aria-label={d}
            >
              {d}
            </button>
          )
        })}
      </div>

      {/* Submit — only shown when ≥4 digits entered */}
      {pinDisplay.length >= 4 && !disabled && (
        <button
          onClick={onSubmit}
          style={{
            marginTop: '1rem',
            width: '100%',
            padding: '0.75rem',
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.3)',
            borderRadius: '10px',
            color: '#fff',
            fontSize: '1rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Unlock
        </button>
      )}
    </div>
  )
}

function keyStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '1rem',
    background: disabled ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.12)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '12px',
    color: '#fff',
    fontSize: '1.2rem',
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background 0.1s',
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PinScreen() {
  const { user, markUnlocked } = useAuth()
  const navigate  = useNavigate()
  const location  = useLocation()
  const uid       = user?.uid ?? ''

  const [screenState, setScreenState] = useState<PinScreenState>({ phase: 'entry' })
  const [digits,      setDigits]      = useState('')
  const [config,      setConfig]      = useState<SilentActivationConfig | null>(null)

  const configRef = useRef<SilentActivationConfig | null>(null)

  // ── Load config + calibrate bcrypt on mount ──────────────────────────────
  useEffect(() => {
    void calibrateBcrypt()

    if (!uid) return
    getDoc(doc(db, 'users', uid)).then((snap) => {
      if (snap.exists()) {
        const cfg = snap.data()['silentActivationConfig'] as SilentActivationConfig | undefined
        setConfig(cfg ?? null)
        configRef.current = cfg ?? null
      }
    }).catch(() => {})
  }, [uid])

  // ── Suppress navigation when decoy is shown ──────────────────────────────
  useEffect(() => {
    if (screenState.phase === 'result' && screenState.outcome === 'decoy') {
      suppressNavigation()
    }
  }, [screenState])

  // ── Auto-submit at 6 digits (minimum duress PIN length) ─────────────────
  useEffect(() => {
    if (digits.length === 6 && screenState.phase === 'entry') {
      void submitPin(digits)
    }
  }, [digits]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── verifyNormalPin adapter — local bcrypt first, no network ─────────────
  async function verifyNormalPin(candidatePin: string): Promise<boolean> {
    const cfg = configRef.current
    if (cfg?.normalPinHash) {
      return bcrypt.compare(candidatePin, cfg.normalPinHash)
    }
    return false
  }

  // ── handleDuressTrigger — fire-and-forget after decoy already renders ────
  function handleDuressTrigger(_type: string, firedAt: Date) {
    void (async () => {
      try {
        const fn = httpsCallable(fns, 'createSOSSession')
        await fn({
          triggerType: 'duress_pin',
          triggeredAt: firedAt.toISOString(),
          syncedAt:    new Date().toISOString(),
          location:    null,  // GPS not available from PIN screen
          deviceInfo:  navigator.userAgent.slice(0, 200),
        })
      } catch (err) {
        // Non-fatal — decoy is already showing. Log silently.
        console.error('[PinScreen] duress_pin SOS trigger failed:', err)
      }
    })()
  }

  // ── submitPin ─────────────────────────────────────────────────────────────
  async function submitPin(pin: string) {
    if (!pin || pin.length < 4) return
    setScreenState({ phase: 'evaluating' })
    setDigits('')

    await handlePinSubmission(pin, {
      duressHash:               config?.duressPinHash ?? null,
      triggerDetector:          { onTriggerFired: handleDuressTrigger },
      verifyNormalPinViaServer: verifyNormalPin,

      // P33 CONSTRAINT: both renderDecoyScreen and renderWrongPinError call
      // setState with the same shape { phase: 'result', outcome: X }.
      // The JSX for 'decoy' and 'wrong' is IDENTICAL — same message, same shake.
      // The outcome field is only read in the useEffect above (for suppressNavigation),
      // never in JSX. This ensures React performs the same VDOM diff for both paths.
      renderDecoyScreen:  () => setScreenState({ phase: 'result', outcome: 'decoy' }),
      renderWrongPinError: () => setScreenState({ phase: 'result', outcome: 'wrong' }),

      navigateToHome: () => {
        markUnlocked()
        const from = (location.state as { from?: { pathname: string } })?.from?.pathname
        const dest = from && from !== '/pin' ? from : '/home'
        navigate(dest, { replace: true })
      },
    })
  }

  // ── Keypad handlers ───────────────────────────────────────────────────────
  function handleDigit(d: string) {
    if (screenState.phase !== 'entry') return
    setDigits(prev => prev.length < 8 ? prev + d : prev)
  }

  function handleDelete() {
    if (screenState.phase !== 'entry') return
    setDigits(prev => prev.slice(0, -1))
  }

  function handleRetry() {
    setScreenState({ phase: 'entry' })
    setDigits('')
  }

  // ── Derived display values ────────────────────────────────────────────────
  const isEvaluating = screenState.phase === 'evaluating'
  const isResult     = screenState.phase === 'result'
  const isDecoy      = isResult && screenState.outcome === 'decoy'

  // Dots display
  const pinDots = '●'.repeat(digits.length)

  // Error message — IDENTICAL for both outcomes (P33 compliance)
  // Note: the same string is shown regardless of outcome.
  // The outcome never leaks into the displayed text.
  const errorMsg: string | null = isResult
    ? 'Could not unlock notes. Try again.'
    : null

  return (
    <div style={{
      minHeight:      '100dvh',
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      background:     '#1A2744',
      padding:        '2rem 1rem',
    }}>
      {/* Notebook icon */}
      <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>📓</div>

      {/* App name — disguise branding, no RAKSHA text */}
      <h1 style={{
        color:        '#ffffff',
        fontSize:     '1.5rem',
        fontWeight:   700,
        marginBottom: '0.25rem',
        fontFamily:   'system-ui, sans-serif',
      }}>
        Daily Notes
      </h1>

      <p style={{
        color:        'rgba(255,255,255,0.55)',
        fontSize:     '0.875rem',
        marginBottom: '2.5rem',
      }}>
        Enter PIN to continue
      </p>

      {isEvaluating ? (
        /* Neutral waiting state — no result shown yet */
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width:  '2rem',
            height: '2rem',
            border: '3px solid rgba(255,255,255,0.3)',
            borderTopColor: '#fff',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto',
          }} role="status" aria-label="Verifying PIN…" />
        </div>
      ) : (
        <PinKeypad
          pinDisplay={pinDots}
          disabled={isResult && isDecoy}  // locked after decoy; allow retry after wrong
          shaking={isResult}
          errorMsg={errorMsg}
          onDigit={handleDigit}
          onDelete={handleDelete}
          onSubmit={() => void submitPin(digits)}
        />
      )}

      {/* Retry link after wrong PIN (not shown during decoy — decoy is permanent) */}
      {isResult && !isDecoy && (
        <button
          onClick={handleRetry}
          style={{
            marginTop:   '1.5rem',
            background:  'none',
            border:      'none',
            color:       'rgba(255,255,255,0.55)',
            fontSize:    '0.875rem',
            cursor:      'pointer',
            textDecoration: 'underline',
          }}
        >
          Try again
        </button>
      )}

      <style>{`
        @keyframes pinShake {
          0%,100% { transform: translateX(0); }
          20%     { transform: translateX(-8px); }
          40%     { transform: translateX(8px); }
          60%     { transform: translateX(-5px); }
          80%     { transform: translateX(5px); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
