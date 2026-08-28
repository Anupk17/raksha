/**
 * OnboardingScreen — 5-step guided first-run setup.
 *
 * STEP STATE: Single route /onboarding, step number in component state.
 * No per-step URLs — avoids browser history pollution and back-button issues.
 * Step is persisted to sessionStorage so /setup can return here correctly.
 *
 * DISGUISE INTEGRITY: Only runs after Firebase auth + PIN unlock (inside
 * RequireAuth + RequirePin). RAKSHA branding is shown since the user has
 * already passed the PIN screen at this point.
 *
 * Skip at any step calls markOnboardingComplete() and navigates to /home.
 * "Go to RAKSHA" at step 5 also calls markOnboardingComplete().
 *
 * Design: §Change 4 — Onboarding Screen
 * Requirements: 1–6
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { doc, setDoc, getDocs, collection, query, where } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../contexts/AuthContext'
import {
  validateContactForm,
  EMPTY_FORM,
  type ContactFormValues,
} from '../utils/trustedContactTypes'
import type { SilentActivationConfig } from '@sa/activationConfig'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OnboardingStep = 1 | 2 | 3 | 4 | 5

const SESSION_STEP_KEY = 'onboarding_step'

// ---------------------------------------------------------------------------
// Progress indicator
// ---------------------------------------------------------------------------

function OnboardingProgress({ step }: { step: OnboardingStep }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginBottom: '2rem' }}>
      {([1,2,3,4,5] as const).map((n) => (
        <div
          key={n}
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: n <= step ? 'var(--accent-green)' : 'var(--surface-3)',
            transition: 'background 0.2s',
          }}
          aria-hidden="true"
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 1 — Welcome
// ---------------------------------------------------------------------------

function WelcomeStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="stack" style={{ textAlign: 'center', alignItems: 'center' }}>
      <div style={{ fontSize: '3.5rem' }}>🛡️</div>
      <h1 style={{ fontSize: '1.6rem' }}>Welcome to RAKSHA</h1>
      <p className="text-muted" style={{ maxWidth: '300px', lineHeight: 1.7 }}>
        RAKSHA helps you stay safe with a <strong>silent SOS trigger</strong> that
        alerts nearby verified guardians, notifies your emergency contacts, and
        captures tamper-proof evidence — all invisible until you need it.
      </p>
      <button className="btn btn-primary" style={{ maxWidth: '280px' }} onClick={onNext}>
        Get started
      </button>
      <button
        className="btn btn-ghost"
        style={{ maxWidth: '280px', fontSize: '0.875rem' }}
        onClick={onSkip}
      >
        Skip setup — take me to the app
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — Permissions
// ---------------------------------------------------------------------------

type PermStatus = 'idle' | 'granted' | 'denied'

function PermissionsStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [locationStatus, setLocationStatus] = useState<PermStatus>('idle')
  const [motionStatus,   setMotionStatus]   = useState<PermStatus>('idle')

  async function requestLocation() {
    return new Promise<void>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => { setLocationStatus('granted'); resolve() },
        () => { setLocationStatus('denied');  resolve() },
        { timeout: 10_000 }
      )
    })
  }

  async function requestMotion() {
    // iOS 13+ requires explicit permission request
    if (typeof (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission === 'function') {
      try {
        const result = await (DeviceMotionEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission()
        setMotionStatus(result === 'granted' ? 'granted' : 'denied')
      } catch {
        setMotionStatus('denied')
      }
      return
    }
    // Android — fire a short listener to detect availability
    await new Promise<void>((resolve) => {
      const handler = () => {
        setMotionStatus('granted')
        window.removeEventListener('devicemotion', handler)
        resolve()
      }
      window.addEventListener('devicemotion', handler, { once: true })
      setTimeout(() => {
        window.removeEventListener('devicemotion', handler)
        setMotionStatus('denied')
        resolve()
      }, 600)
    })
  }

  const statusIcon = (s: PermStatus) =>
    s === 'granted' ? '✅' : s === 'denied' ? '⚠️' : '○'

  return (
    <div className="stack">
      <h2 style={{ textAlign: 'center', marginBottom: '0.5rem' }}>Permissions</h2>
      <p className="text-muted text-sm" style={{ textAlign: 'center', marginBottom: '1rem' }}>
        RAKSHA works best with these permissions.
      </p>

      {/* Location */}
      <div className="card stack-sm">
        <div className="row-between">
          <div>
            <p style={{ fontWeight: 600 }}>📍 Location {statusIcon(locationStatus)}</p>
            <p className="text-muted text-xs" style={{ marginTop: '0.25rem', lineHeight: 1.5 }}>
              Helps nearby verified guardians find you in an emergency.
              Also creates an anonymous location hash stored with your SOS session.
            </p>
          </div>
        </div>
        {locationStatus === 'denied' && (
          <p className="text-muted text-xs" style={{ color: 'var(--accent-amber)' }}>
            Without location, nearby guardians won't be alerted — your emergency
            contacts will be notified instead.
          </p>
        )}
        {locationStatus === 'idle' && (
          <button
            className="btn btn-ghost"
            style={{ fontSize: '0.875rem', padding: '0.4rem' }}
            onClick={() => void requestLocation()}
          >
            Grant location access
          </button>
        )}
      </div>

      {/* Motion */}
      <div className="card stack-sm">
        <div className="row-between">
          <div>
            <p style={{ fontWeight: 600 }}>📳 Motion sensors {statusIcon(motionStatus)}</p>
            <p className="text-muted text-xs" style={{ marginTop: '0.25rem', lineHeight: 1.5 }}>
              Lets Shake to Trigger work even when your screen is locked,
              without needing to open the app.
            </p>
          </div>
        </div>
        {motionStatus === 'denied' && (
          <p className="text-muted text-xs" style={{ color: 'var(--accent-amber)' }}>
            Shake to Trigger won't work without motion access. You can still use
            Duress PIN.
          </p>
        )}
        {motionStatus === 'idle' && (
          <button
            className="btn btn-ghost"
            style={{ fontSize: '0.875rem', padding: '0.4rem' }}
            onClick={() => void requestMotion()}
          >
            Grant motion access
          </button>
        )}
      </div>

      <button className="btn btn-primary" onClick={onNext}>Continue</button>
      <button className="btn btn-ghost" style={{ fontSize: '0.875rem' }} onClick={onSkip}>
        Skip setup
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 3 — Add Trusted Contact
// ---------------------------------------------------------------------------

function TrustedContactStep({
  uid, onNext, onSkip,
}: { uid: string; onNext: () => void; onSkip: () => void }) {
  const [values,  setValues]  = useState<ContactFormValues>(EMPTY_FORM)
  const [error,   setError]   = useState<string | null>(null)
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(false)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const err = validateContactForm(values, [], undefined)
    if (err) { setError(err); return }
    setError(null)
    setSaving(true)
    try {
      const id  = crypto.randomUUID()
      const now = new Date()
      await setDoc(doc(db, 'trusted_contacts', id), {
        id,
        ownerUserId:           uid,
        name:                  values.name.trim(),
        phoneNumber:           values.phoneNumber.trim(),
        relationship:          values.relationship.trim(),
        notifyOnSOS:           values.notifyOnSOS,
        notifyOnDigitalThreat: false,
        priority:              1,
        createdAt:             now,
        updatedAt:             now,
      })
      setSaved(true)
    } catch (err) {
      setError(`Could not save: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  if (saved) {
    return (
      <div className="stack" style={{ textAlign: 'center', alignItems: 'center' }}>
        <div style={{ fontSize: '2.5rem' }}>✅</div>
        <p style={{ fontWeight: 600 }}>Contact added!</p>
        <p className="text-muted text-sm">
          You can add more contacts any time in Settings → Trusted contacts.
        </p>
        <button className="btn btn-primary" style={{ maxWidth: '280px' }} onClick={onNext}>
          Continue
        </button>
      </div>
    )
  }

  return (
    <div className="stack">
      <h2 style={{ textAlign: 'center', marginBottom: '0.25rem' }}>Add an emergency contact</h2>
      <p className="text-muted text-sm" style={{ textAlign: 'center', marginBottom: '1rem' }}>
        This person will be notified if no guardian is nearby when you trigger SOS.
      </p>

      <form onSubmit={(e) => void handleSave(e)} className="stack-sm">
        {error && <div className="banner banner-error" role="alert">{error}</div>}

        <div className="input-group">
          <label className="input-label" htmlFor="ob-name">Name *</label>
          <input id="ob-name" className="input" type="text" placeholder="e.g. Priya Sharma"
            value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
            maxLength={50} required />
        </div>

        <div className="input-group">
          <label className="input-label" htmlFor="ob-phone">Phone number *</label>
          <input id="ob-phone" className="input" type="tel" placeholder="e.g. +91 98765 43210"
            value={values.phoneNumber} onChange={(e) => setValues((v) => ({ ...v, phoneNumber: e.target.value }))}
            maxLength={15} required />
        </div>

        <div className="input-group">
          <label className="input-label" htmlFor="ob-rel">Relationship (optional)</label>
          <input id="ob-rel" className="input" type="text" placeholder="e.g. Sister, Friend"
            value={values.relationship} onChange={(e) => setValues((v) => ({ ...v, relationship: e.target.value }))}
            maxLength={30} />
        </div>

        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save and continue'}
        </button>
      </form>

      <button
        className="btn btn-ghost"
        style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}
        onClick={onSkip}
      >
        Skip — I'll add contacts later in Settings
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 4 — Configure Trigger
// ---------------------------------------------------------------------------

function TriggerStep({ onSkip }: { onNext: () => void; onSkip: () => void }) {
  const navigate = useNavigate()

  function goToSetup() {
    sessionStorage.setItem(SESSION_STEP_KEY, '5')
    navigate('/setup', { state: { returnTo: '/onboarding' } })
  }

  return (
    <div className="stack">
      <h2 style={{ textAlign: 'center', marginBottom: '0.25rem' }}>Configure a silent trigger</h2>
      <p className="text-muted text-sm" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
        Set up how you'll silently activate SOS — without anyone nearby knowing.
      </p>

      <div className="card stack-sm">
        <p style={{ fontWeight: 500 }}>🤝 Shake to Trigger</p>
        <p className="text-muted text-xs">Shake your phone firmly — works even with the screen locked.</p>
        <p style={{ fontWeight: 500 }}>🔑 Duress PIN</p>
        <p className="text-muted text-xs">Enter a secret PIN that looks like a normal app-unlock.</p>
      </div>

      <button className="btn btn-primary" onClick={goToSetup}>
        Configure triggers
      </button>
      <button
        className="btn btn-ghost"
        style={{ fontSize: '0.875rem' }}
        onClick={onSkip}
      >
        Skip — configure later
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 5 — Completion
// ---------------------------------------------------------------------------

function CompletionStep({ uid, onDone }: { uid: string; onDone: () => void }) {
  const [hasTrigger, setHasTrigger] = useState<boolean | null>(null)
  const [hasContact, setHasContact] = useState<boolean | null>(null)

  useEffect(() => {
    // Read trigger config to show personalised hint
    void (async () => {
      try {
        const { getDoc } = await import('firebase/firestore')
        const snap = await getDoc(doc(db, 'users', uid))
        if (snap.exists()) {
          const cfg = snap.data()['silentActivationConfig'] as SilentActivationConfig | undefined
          setHasTrigger(!!(cfg?.shakeEnabled || cfg?.duressPinEnabled))
        } else {
          setHasTrigger(false)
        }
        const q = query(collection(db, 'trusted_contacts'), where('ownerUserId', '==', uid))
        const snap2 = await getDocs(q)
        setHasContact(!snap2.empty)
      } catch {
        setHasTrigger(false)
        setHasContact(false)
      }
    })()
  }, [uid])

  return (
    <div className="stack" style={{ textAlign: 'center', alignItems: 'center' }}>
      <div style={{ fontSize: '3.5rem' }}>✅</div>
      <h1 style={{ fontSize: '1.5rem' }}>You're set up!</h1>

      <div className="card stack-sm" style={{ textAlign: 'left', width: '100%', maxWidth: '320px' }}>
        {hasTrigger ? (
          <p className="text-muted text-sm">
            🤝 <strong>Trigger ready.</strong> Shake your phone firmly or enter your Duress PIN
            to silently activate SOS.
          </p>
        ) : (
          <p className="text-muted text-sm" style={{ color: 'var(--accent-amber)' }}>
            ⚠️ No trigger configured yet. Go to Settings → Configure triggers to set one up.
          </p>
        )}
        {hasContact ? (
          <p className="text-muted text-sm">
            👥 <strong>Emergency contact saved.</strong> They'll be notified if no guardian
            is nearby.
          </p>
        ) : (
          <p className="text-muted text-sm" style={{ color: 'var(--accent-amber)' }}>
            ⚠️ No emergency contact added. Go to Settings → Trusted contacts to add one.
          </p>
        )}
      </div>

      <button className="btn btn-primary" style={{ maxWidth: '280px' }} onClick={onDone}>
        Go to RAKSHA
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OnboardingScreen() {
  const { user, markOnboardingComplete } = useAuth()
  const navigate = useNavigate()
  const uid = user!.uid

  // Restore step from sessionStorage (set when navigating to /setup)
  const [step, setStep] = useState<OnboardingStep>(() => {
    const saved = sessionStorage.getItem(SESSION_STEP_KEY)
    sessionStorage.removeItem(SESSION_STEP_KEY)
    return saved ? (parseInt(saved, 10) as OnboardingStep) : 1
  })

  async function handleSkip() {
    await markOnboardingComplete()
    navigate('/home', { replace: true })
  }

  async function handleDone() {
    await markOnboardingComplete()
    navigate('/home', { replace: true })
  }

  return (
    <div className="screen" style={{ paddingTop: '2rem' }}>
      <OnboardingProgress step={step} />

      {step === 1 && (
        <WelcomeStep onNext={() => setStep(2)} onSkip={() => void handleSkip()} />
      )}
      {step === 2 && (
        <PermissionsStep onNext={() => setStep(3)} onSkip={() => void handleSkip()} />
      )}
      {step === 3 && (
        <TrustedContactStep uid={uid} onNext={() => setStep(4)} onSkip={() => setStep(4)} />
      )}
      {step === 4 && (
        <TriggerStep onNext={() => setStep(5)} onSkip={() => setStep(5)} />
      )}
      {step === 5 && (
        <CompletionStep uid={uid} onDone={() => void handleDone()} />
      )}
    </div>
  )
}
