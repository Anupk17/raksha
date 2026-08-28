/**
 * HomeScreen — trigger readiness dashboard.
 *
 * Section 6: triggeredAt = new Date() is captured at the exact moment
 * the "Trigger SOS" button is pressed, then passed as Date in location.state.
 * It is never reconstructed inside CountdownScreen or useCountdown.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { signOut } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth, db, fns } from '../firebase'
import { useAuth } from '../contexts/AuthContext'
import { useSilentActivation } from '../hooks/useSilentActivation'
import type { SilentActivationConfig } from '@sa/activationConfig'

type TriggerType = 'power_button' | 'earbud' | 'shake' | 'duress_phrase' | 'duress_pin'

interface TestResult { success: boolean }

function getPreferredTriggerType(config: SilentActivationConfig): TriggerType {
  return config.shakeEnabled       ? 'shake'
    : config.duressPinEnabled      ? 'duress_pin'
    : 'shake'
}

export function HomeScreen() {
  const { user, lockApp }  = useAuth()
  const navigate  = useNavigate()
  const uid       = user!.uid

  const [config,     setConfig]     = useState<SilentActivationConfig | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing,    setTesting]    = useState(false)

  const runTestTrigger = useCallback(async (triggerType: TriggerType, triggeredAt: Date) => {
    if (!config) return

    setTesting(true)
    setTestResult(null)

    try {
      const fn = httpsCallable<unknown, TestResult>(fns, 'testTrigger')
      await fn({
        triggerType,
        triggeredAt: triggeredAt.toISOString(),
        syncedAt: new Date().toISOString(),
        location: null,
        deviceInfo: navigator.userAgent.slice(0, 200),
      })
      setTestResult('✓ Test successful — your trigger is configured correctly.')
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? 'unknown'
      setTestResult(
        import.meta.env.VITE_USE_EMULATOR === 'true'
          ? `Test failed: ${code}`
          : 'Test failed. Please check your configuration.'
      )
    } finally {
      setTesting(false)
    }
  }, [config])

  const triggerSOS = useCallback(async (triggerType: TriggerType, triggeredAt = new Date()) => {
    if (!config) {
      return
    }

    if (config.testMode) {
      await runTestTrigger(triggerType, triggeredAt)
      return
    }

    navigate('/countdown', { state: { triggeredAt, triggerType } })
  }, [config, navigate, runTestTrigger])

  useSilentActivation({
    config,
    onTrigger: (triggeredAt, type) => triggerSOS(type, triggeredAt),
  })

  useEffect(() => {
    getDoc(doc(db, 'users', uid)).then((snap) => {
      if (snap.exists()) {
        setConfig((snap.data()['silentActivationConfig'] as SilentActivationConfig) ?? null)
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [uid])

  const enabledTriggers: string[] = []
  if (config?.shakeEnabled)        enabledTriggers.push('Shake')
  if (config?.duressPinEnabled)    enabledTriggers.push('Duress PIN')
  const primaryTriggerType = config ? getPreferredTriggerType(config) : null

  if (loading) return <div className="screen-centered"><div className="spinner" /></div>

  return (
    <div className="screen">
      {/* Nav */}
      <nav className="nav-bar">
        <span className="nav-logo">🛡️ RAKSHA</span>
        <div className="nav-links">
          <Link to="/guardian-inbox" className="nav-link">Guardian Inbox</Link>
          <button
            className="btn btn-ghost btn-sm"
            style={{ width: 'auto' }}
            onClick={() => { lockApp(); void signOut(auth) }}
          >
            Sign out
          </button>
        </div>
      </nav>

      {/* Status card */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="row-between" style={{ marginBottom: '1rem' }}>
          <h2>Protection Status</h2>
          {enabledTriggers.length > 0
            ? <span className="chip chip-green">● Active</span>
            : <span className="chip chip-red">⚠ Not set up</span>
          }
        </div>

        {enabledTriggers.length === 0 ? (
          <div className="banner banner-warning" role="alert">
            No triggers configured. RAKSHA will not respond to any gesture.
            <Link to="/settings" style={{ marginLeft: '0.5rem', fontWeight: 600 }}>Set up now →</Link>
          </div>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
            {enabledTriggers.map((t) => (
              <span key={t} className="chip chip-green">✓ {t}</span>
            ))}
          </div>
        )}

        {config?.testMode && (
          <div className="banner banner-warning" role="alert" style={{ marginTop: '1rem' }}>
            🧪 Test mode is active — real SOS is disabled.
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="stack">
        {config?.testMode ? (
          <>
            <div className="banner banner-info">
              Test mode is ON. Press below to verify your configuration safely.
            </div>
            <button
              id="test-trigger-btn"
              className="btn btn-ghost"
              disabled={testing || !config}
              onClick={() => primaryTriggerType ? void triggerSOS(primaryTriggerType) : undefined}
            >
              {testing ? 'Running test…' : '🔬 Test my triggers safely'}
            </button>
          </>
        ) : (
          <button
            id="trigger-sos-btn"
            className="btn btn-primary"
            disabled={enabledTriggers.length === 0}
            onClick={() => primaryTriggerType ? void triggerSOS(primaryTriggerType) : undefined}
            style={{ padding: '1.25rem' }}
          >
            🚨 Trigger SOS
            <span className="text-sm" style={{ opacity: 0.8, fontWeight: 400, marginLeft: '0.25rem' }}>
              (web test)
            </span>
          </button>
        )}

        {testResult && (
          <div
            className={`banner ${testResult.startsWith('✓') ? 'banner-info' : 'banner-error'}`}
            role="alert"
          >
            {testResult}
            <button
              className="btn-ghost"
              style={{ background: 'none', border: 'none', cursor: 'pointer', marginLeft: '0.5rem', color: 'inherit' }}
              onClick={() => setTestResult(null)}
            >✕</button>
          </div>
        )}

        <Link to="/settings" className="btn btn-ghost" style={{ textAlign: 'center', padding: '0.75rem' }}>
          ⚙ Settings
        </Link>

        {config?.shakeEnabled && (
          <button
            id="simulate-shake"
            className="btn btn-ghost"
            onClick={() => triggerSOS('shake', new Date())}
            style={{ textAlign: 'center', padding: '0.5rem', marginTop: '0.25rem', fontSize: '0.875rem' }}
          >
            🧪 Simulate Shake Trigger
          </button>
        )}
      </div>

      {/* Footer hint */}
      <p className="text-muted text-xs" style={{ marginTop: 'auto', paddingTop: '2rem', textAlign: 'center' }}>
        Open browser dev tools (on phone via remote debugging) to see debug logs.
      </p>
    </div>
  )
}
