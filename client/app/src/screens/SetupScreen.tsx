/**
 * SetupScreen — trigger configuration.
 *
 * Section 6 guardrail: duress PIN held in useRef, NEVER useState.
 * It is passed directly to saveActivationConfig() and the ref is zeroed
 * after the call — it never appears in React DevTools or network logs.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { signOut } from 'firebase/auth'
import { auth, db } from '../firebase'
import { useAuth } from '../contexts/AuthContext'
import { TriggerRow } from '../components/TriggerRow'
import { DisableAllModal } from '../components/DisableAllModal'
import {
  validateActivationConfig,
  saveActivationConfig,
  type SilentActivationConfig,
  type ConfigValidationError,
} from '@sa/activationConfig'

export function SetupScreen() {
  const { user, lockApp } = useAuth()
  const navigate  = useNavigate()
  const location  = useLocation()
  const uid       = user!.uid

  // ── Form state (non-PIN fields only) ─────────────────────────────────────
  const [config, setConfig] = useState<SilentActivationConfig>({})
  const [fieldErrors, setFieldErrors] = useState<ConfigValidationError[]>([])
  const [banner,  setBanner]  = useState<{ type: 'error' | 'success'; msg: string } | null>(null)
  const [saving,  setSaving]  = useState(false)
  const [loading, setLoading] = useState(true)
  const [showDisableModal, setShowDisableModal] = useState(false)

  // Section 6: PIN values held in refs — never in state
  const duressPinRef       = useRef('')
  const confirmPinRef      = useRef('')
  const normalPinRef       = useRef('')
  const normalPinConfirmRef = useRef('')

  useEffect(() => {
    getDoc(doc(db, 'users', uid)).then((snap) => {
      if (snap.exists()) {
        const data = snap.data()
        const existing = data['silentActivationConfig'] as SilentActivationConfig | undefined
        if (existing) {
          if (existing.powerButtonTapCount !== undefined && existing.powerButtonTapCount !== null) {
            existing.powerButtonTapCount = typeof existing.powerButtonTapCount === 'string'
              ? parseInt(existing.powerButtonTapCount, 10)
              : Number(existing.powerButtonTapCount)
          }
          setConfig(existing)
        }
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [uid])

  function fieldError(field: string) {
    return fieldErrors.find((e) => e.field === field)?.message
  }

  // ── Save flow ─────────────────────────────────────────────────────────────
  async function doSave() {
    const full: SilentActivationConfig = {
      ...config,
      duressPin:        config.duressPinEnabled ? duressPinRef.current         : undefined,
      normalPin:        normalPinRef.current || undefined,  // used by both App Lock and Duress PIN mismatch guard
      normalPinConfirm: config.pinLockEnabled   ? normalPinConfirmRef.current  : undefined,
    }

    // Validate (including PIN fields) — never throws
    const errors = validateActivationConfig(full)
    if (config.duressPinEnabled && duressPinRef.current !== confirmPinRef.current) {
      errors.push({ field: 'duressPin', message: 'PINs do not match.' })
    }
    if (errors.length) {
      setFieldErrors(errors)
      return
    }
    setFieldErrors([])

    // Persist — use a short timeout since we only need the local write to succeed.
    // On Android, Firestore writes are queued locally and sync when the emulator
    // is reachable — we don't need to wait for the server ACK to navigate home.
    setSaving(true)
    setBanner(null)
    try {
      const savePromise = saveActivationConfig(uid, full, async (userId, patch) => {
        // Write the complete config — do NOT strip false/undefined, saveActivationConfig
        // already writes explicit false for all boolean flags so the full map persists.
        const cleaned = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined)
        )
        void setDoc(doc(db, 'users', userId), { silentActivationConfig: cleaned }, { merge: true })
      })
      // saveActivationConfig itself (bcrypt hash if PIN enabled) must complete
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Save timed out')), 5000)
      )
      await Promise.race([savePromise, timeoutPromise])
      // Zero PIN refs after save (belt-and-suspenders; saveActivationConfig already zeroes)
      duressPinRef.current      = ''
      confirmPinRef.current     = ''
      normalPinRef.current      = ''
      normalPinConfirmRef.current = ''
      setBanner({ type: 'success', msg: 'Triggers saved.' })
      // Return to onboarding if that's where we came from
      const returnTo = (location.state as { returnTo?: string } | null)?.returnTo
      setTimeout(() => navigate(returnTo ?? '/home', { replace: true }), 1000)
    } catch (err: unknown) {
      console.error('[SetupScreen] saveActivationConfig failed:', err)
      const errMsg = err instanceof Error ? err.message : String(err)
      setBanner({
        type: 'error',
        msg: import.meta.env.VITE_USE_EMULATOR === 'true'
          ? `Could not save configuration: ${errMsg}`
          : 'Could not save configuration. Please try again.'
      })
    } finally {
      setSaving(false)
    }
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const anyEnabled =
      config.powerButtonEnabled ||
      config.earbudEnabled ||
      config.shakeEnabled ||
      config.duressPinEnabled ||
      config.duressPhraseEnabled
    if (!anyEnabled) {
      setShowDisableModal(true)
      return
    }
    void doSave()
  }

  if (loading) {
    return <div className="screen-centered"><div className="spinner" /></div>
  }

  return (
    <div className="screen">
      {/* Nav */}
      <nav className="nav-bar">
        <span className="nav-logo">🛡️ RAKSHA</span>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto' }} onClick={() => { lockApp(); void signOut(auth) }}>
          Sign out
        </button>
      </nav>

      <h1 style={{ marginBottom: '0.375rem' }}>Trigger Setup</h1>
      <p className="text-muted text-sm" style={{ marginBottom: '1.75rem' }}>
        Enable the gestures that will silently activate your SOS.
      </p>

      <form onSubmit={handleSave} className="stack">

        {/* ── App Lock PIN ── */}
        <div className="card stack-sm">
          <div className="row-between">
            <div>
              <p style={{ fontWeight: 600 }}>App Lock PIN</p>
              <p className="text-muted text-xs">
                Requires a PIN each time the app opens
              </p>
            </div>
            <input
              type="checkbox"
              id="pin-lock-toggle"
              className="toggle"
              checked={!!config.pinLockEnabled}
              onChange={(e) => setConfig((c) => ({ ...c, pinLockEnabled: e.target.checked }))}
            />
          </div>

          {config.pinLockEnabled && (
            <div className="stack-sm" style={{ marginTop: '0.25rem' }}>
              <div className="input-group">
                <label className="input-label" htmlFor="normal-pin-setup">
                  Normal PIN (4–8 digits)
                </label>
                <input
                  id="normal-pin-setup"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  className={`input ${fieldError('normalPin') ? 'input-error' : ''}`}
                  placeholder="4–8 digits"
                  onChange={(e) => { normalPinRef.current = e.target.value }}
                />
                {fieldError('normalPin') && (
                  <p className="field-error">{fieldError('normalPin')}</p>
                )}
              </div>
              <div className="input-group">
                <label className="input-label" htmlFor="normal-pin-confirm-setup">
                  Confirm Normal PIN
                </label>
                <input
                  id="normal-pin-confirm-setup"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  className="input"
                  placeholder="Repeat the PIN"
                  onChange={(e) => { normalPinConfirmRef.current = e.target.value }}
                />
              </div>
              <p className="text-muted text-xs">
                Keep this different from your Duress PIN.
              </p>
            </div>
          )}
        </div>

        {/* ── Power Button ── */}
        <TriggerRow
          id="power-btn-toggle"
          label="Power Button"
          sublabel="Rapid taps to trigger (Android only)"
          checked={!!config.powerButtonEnabled}
          onChange={(v) => setConfig((c) => ({ ...c, powerButtonEnabled: v }))}
          comingSoon
        >
          <div className="input-group">
            <label className="input-label" htmlFor="tap-count">Number of taps (3–7)</label>
            <div className="select-wrapper">
              <select
                id="tap-count"
                className={`input select-input ${fieldError('powerButtonTapCount') ? 'input-error' : ''}`}
                value={config.powerButtonTapCount ?? 5}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, powerButtonTapCount: parseInt(e.target.value, 10) }))
                }
              >
                {[3, 4, 5, 6, 7].map((n) => (
                  <option key={n} value={n}>{n} taps</option>
                ))}
              </select>
            </div>
            {fieldError('powerButtonTapCount') && (
              <p className="field-error">{fieldError('powerButtonTapCount')}</p>
            )}
          </div>
        </TriggerRow>

        {/* ── Earbud ── */}
        <TriggerRow
          id="earbud-toggle"
          label="Earbud Triple-Click"
          sublabel="Triple-click the earbud button"
          checked={!!config.earbudEnabled}
          onChange={(v) => setConfig((c) => ({ ...c, earbudEnabled: v }))}
          comingSoon
        />

        {/* ── Shake ── */}
        <TriggerRow
          id="shake-toggle"
          label="Shake to Trigger"
          sublabel="Shake phone sharply — works when screen is locked"
          checked={!!config.shakeEnabled}
          onChange={(v) => setConfig((c) => ({ ...c, shakeEnabled: v }))}
        >
          <div className="input-group">
            <label className="input-label" htmlFor="shake-sensitivity">Sensitivity</label>
            <div className="select-wrapper">
              <select
                id="shake-sensitivity"
                className="input select-input"
                value={config.shakeSensitivity ?? 2}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    shakeSensitivity: parseInt(e.target.value, 10) as 1 | 2 | 3,
                  }))
                }
              >
                <option value={1}>Light — moderate shake</option>
                <option value={2}>Medium — firm shake (recommended)</option>
                <option value={3}>Strong — hard, deliberate shake</option>
              </select>
            </div>
            <p className="text-muted text-xs" style={{ marginTop: '0.375rem' }}>
              Start with Medium. If false triggers occur during daily use, increase to Strong.
            </p>
          </div>
        </TriggerRow>

        {/* ── Duress PIN ── */}
        <TriggerRow
          id="duress-pin-toggle"
          label="Duress PIN"
          sublabel="A secret PIN that looks like a normal login"
          checked={!!config.duressPinEnabled}
          onChange={(v) => setConfig((c) => ({ ...c, duressPinEnabled: v }))}
        >
          <div className="stack-sm">
            <div className="input-group">
              <label className="input-label" htmlFor="duress-pin">
                Duress PIN (6–8 digits)
              </label>
              <input
                id="duress-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                className={`input ${fieldError('duressPin') ? 'input-error' : ''}`}
                placeholder="6–8 digits"
                /* Section 6: value is never read back into state — only into ref */
                onChange={(e) => { duressPinRef.current = e.target.value }}
              />
              {fieldError('duressPin') && <p className="field-error">{fieldError('duressPin')}</p>}
            </div>
            <div className="input-group">
              <label className="input-label" htmlFor="confirm-pin">Confirm Duress PIN</label>
              <input
                id="confirm-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                className="input"
                placeholder="Repeat the PIN"
                onChange={(e) => { confirmPinRef.current = e.target.value }}
              />
            </div>
            {/* Normal login PIN field — only shown when App Lock PIN is not configured
                (the App Lock section already collected the normal PIN in that case) */}
            {!config.pinLockEnabled && (
              <div className="input-group">
                <label className="input-label" htmlFor="normal-pin">Your normal login PIN</label>
                <input
                  id="normal-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  className="input"
                  placeholder="Must differ from duress PIN"
                  onChange={(e) => { normalPinRef.current = e.target.value }}
                />
              </div>
            )}
          </div>
        </TriggerRow>

        {/* ── Duress Phrase ── */}
        <TriggerRow
          id="duress-phrase-toggle"
          label="Duress Phrase"
          sublabel="Say a secret phrase to activate"
          checked={!!config.duressPhraseEnabled}
          onChange={(v) => setConfig((c) => ({ ...c, duressPhraseEnabled: v }))}
          comingSoon
        >
          <div className="input-group">
            <label className="input-label" htmlFor="duress-phrase">
              Duress phrase (3–50 chars, ≥ 2 words)
            </label>
            <input
              id="duress-phrase"
              type="text"
              className={`input ${fieldError('duressPhrase') ? 'input-error' : ''}`}
              placeholder="e.g. Call me back later"
              value={config.duressPhrase ?? ''}
              onChange={(e) => setConfig((c) => ({ ...c, duressPhrase: e.target.value }))}
            />
            {fieldError('duressPhrase') && <p className="field-error">{fieldError('duressPhrase')}</p>}
          </div>
        </TriggerRow>

        {/* General error */}
        {fieldError('general') && (
          <div className="banner banner-error" role="alert">{fieldError('general')}</div>
        )}

        {banner && (
          <div className={`banner ${banner.type === 'success' ? 'banner-info' : 'banner-error'}`} role="alert">
            {banner.msg}
          </div>
        )}

        <div className="stack-sm" style={{ marginTop: '0.5rem' }}>
          <button id="save-config-btn" type="submit" className="btn btn-safe" disabled={saving}>
            {saving ? 'Saving…' : 'Save triggers'}
          </button>
          <button
            id="back-home-btn"
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate('/home')}
          >
            Back
          </button>
        </div>
      </form>

      {showDisableModal && (
        <DisableAllModal
          onConfirm={() => { setShowDisableModal(false); void doSave() }}
          onCancel={() => setShowDisableModal(false)}
        />
      )}
    </div>
  )
}
