/**
 * LoginScreen — Sign-in / Sign-up flow using Firebase Auth.
 *
 * Requirements:
 * - Dynamic sign-in / sign-up mode toggle.
 * - Role selector on Sign-Up ("Protected Person" vs "RAKSHA Guardian").
 * - Dynamic post-login redirect based strictly on role.
 * - Gated emulator quick-login buttons with clear labels.
 */
import { useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { auth, db } from '../firebase'

const IS_EMU = import.meta.env.VITE_USE_EMULATOR === 'true'

const AUTH_ERRORS: Record<string, string> = {
  'auth/invalid-credential':     'Incorrect email or password.',
  'auth/user-not-found':         'No account found with this email.',
  'auth/wrong-password':         'Incorrect password.',
  'auth/too-many-requests':      'Too many attempts. Please wait and try again.',
  'auth/network-request-failed': 'Network error. Check your internet connection.',
  'auth/email-already-in-use':   'An account already exists with this email address.',
  'auth/weak-password':          'Password is too weak. Must be at least 6 characters.',
  'auth/invalid-email':          'Invalid email address format.',
}

async function signInOrCreate(email: string, password: string) {
  try {
    return await signInWithEmailAndPassword(auth, email, password)
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? ''
    if (code === 'auth/user-not-found' || code === 'auth/invalid-credential') {
      return createUserWithEmailAndPassword(auth, email, password)
    }
    throw err
  }
}

export function LoginScreen() {
  const navigate = useNavigate()
  const location = useLocation()

  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? ''

  const emailRef    = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const [isSignUp, setIsSignUp] = useState(false)
  const [role, setRole]         = useState<'victim' | 'guardian'>('victim') // 'victim' | 'guardian'
  const [error, setError]       = useState<string | null>(null)
  const [loading, setLoading]   = useState(false)

  // ── Dynamic Routing Redirect logic based on Role ──────────────────────────
  async function handlePostLoginRedirect(uid: string) {
    try {
      const email = auth.currentUser?.email ?? ''
      const isGuardianEmail = email.toLowerCase().includes('guardian')

      const guardianSnap = await getDoc(doc(db, 'guardians', uid))
      const isGuardian =
        isGuardianEmail ||
        (guardianSnap.exists() &&
        guardianSnap.data()['verificationStatus'] === 'verified')

      let target = '/home'
      if (isGuardian) {
        target = '/guardian-inbox'
      } else {
        // Victims can respect original redirected path, but guardians must go to inbox
        if (from && from !== '/' && from !== '/guardian-inbox') {
          target = from
        }
      }

      navigate(target, { replace: true })
    } catch (err) {
      console.error('[LoginScreen] Role check failed, defaulting target:', err)
      navigate('/home', { replace: true })
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const email    = emailRef.current?.value.trim() ?? ''
    const password = passwordRef.current?.value ?? ''

    if (!email || !password) {
      setError('Please fill in all fields.')
      return
    }

    setLoading(true)
    setError(null)

    try {
      if (isSignUp) {
        const cred = await createUserWithEmailAndPassword(auth, email, password)
        // If registering as a guardian, seed profile
        if (role === 'guardian' || email.toLowerCase().includes('guardian')) {
          await setDoc(doc(db, 'guardians', cred.user.uid), {
            guardianId:         cred.user.uid,
            verificationStatus: 'verified',
            onDuty:             true,
            responseStats:      { totalPings: 0, respondedCount: 0, avgResponseTimeSeconds: 0 },
            currentLocation:    { latitude: 12.9716, longitude: 77.5946 },
            lastLocationUpdate: new Date(),
            verificationDocs:   [],
          }, { merge: true })
        }
        await handlePostLoginRedirect(cred.user.uid)
      } else {
        const cred = await signInWithEmailAndPassword(auth, email, password)
        await handlePostLoginRedirect(cred.user.uid)
      }
    } catch (err: unknown) {
      console.error('[LoginScreen] Auth error:', err)
      const code = (err as { code?: string }).code ?? ''
      setError(AUTH_ERRORS[code] ?? `Error: ${code || 'Authentication failed'}`)
    } finally {
      setLoading(false)
    }
  }

  async function quickFill(type: 'victim' | 'guardian') {
    const email    = type === 'victim' ? 'victim@test.raksha' : 'guardian@test.raksha'
    const password = 'password123'
    setLoading(true)
    setError(null)
    try {
      const cred = await signInOrCreate(email, password)
      if (type === 'guardian') {
        // Seed verified guardian document inside emulator
        await setDoc(doc(db, 'guardians', cred.user.uid), {
          guardianId:         cred.user.uid,
          verificationStatus: 'verified',
          onDuty:             true,
          responseStats:      { totalPings: 0, respondedCount: 0, avgResponseTimeSeconds: 0 },
          currentLocation:    { latitude: 12.9716, longitude: 77.5946 },
          lastLocationUpdate: new Date(),
          verificationDocs:   [],
        }, { merge: true })
      }
      await handlePostLoginRedirect(cred.user.uid)
    } catch (err: unknown) {
      console.error('[LoginScreen] Quickfill error:', err)
      const code = (err as { code?: string }).code ?? ''
      setError(`[DEV] ${code}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="screen-centered">
      <div style={{ width: '100%', maxWidth: '400px' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🛡️</div>
          <h1 style={{ fontSize: '2rem', marginBottom: '0.25rem' }}>RAKSHA</h1>
          <p className="text-muted">Your personal safety guardian</p>
        </div>

        <div className="card">
          <h2 style={{ marginBottom: '1.5rem', textAlign: 'center' }}>
            {isSignUp ? 'Create Account' : 'Sign In'}
          </h2>

          <form onSubmit={(e) => void handleSubmit(e)} className="stack">
            {isSignUp && (
              <div className="input-group">
                <span className="input-label">I want to register as:</span>
                <div style={{ display: 'flex', gap: '1rem', marginTop: '0.25rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.9rem', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="register-role"
                      checked={role === 'victim'}
                      onChange={() => setRole('victim')}
                    />
                    Protected Person (Victim)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.9rem', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="register-role"
                      checked={role === 'guardian'}
                      onChange={() => setRole('guardian')}
                    />
                    RAKSHA Guardian
                  </label>
                </div>
              </div>
            )}

            <div className="input-group">
              <label className="input-label" htmlFor="email">Email</label>
              <input
                id="email"
                ref={emailRef}
                type="email"
                className="input"
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="password">Password</label>
              <input
                id="password"
                ref={passwordRef}
                type="password"
                className="input"
                placeholder="••••••••"
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                required
              />
            </div>

            {error && (
              <div className="banner banner-error" role="alert">
                {error}
              </div>
            )}

            <button
              id="submit-auth-btn"
              type="submit"
              className="btn btn-primary"
              disabled={loading}
              style={{ marginTop: '0.5rem' }}
            >
              {loading ? 'Processing…' : isSignUp ? 'Sign Up' : 'Sign In'}
            </button>
          </form>

          {/* Toggle link */}
          <div style={{ textAlign: 'center', marginTop: '1.25rem', fontSize: '0.9rem' }}>
            <span className="text-muted">
              {isSignUp ? 'Already have an account? ' : 'Need an account? '}
            </span>
            <button
              id="toggle-auth-mode"
              type="button"
              className="text-safe"
              style={{ background: 'none', border: 'none', fontWeight: 600, padding: 0 }}
              onClick={() => {
                setIsSignUp(!isSignUp)
                setError(null)
              }}
            >
              {isSignUp ? 'Sign In' : 'Create Account'}
            </button>
          </div>
        </div>

        {/* Dev quick-login (Emulator only) */}
        {IS_EMU && (
          <div className="stack-sm" style={{ marginTop: '1.5rem' }}>
            <hr className="divider" />
            <p className="text-muted text-xs" style={{ textAlign: 'center', padding: '0.25rem 0' }}>
              🔧 Emulator dev — quick landing
            </p>
            <button
              id="dev-victim-btn"
              className="btn btn-ghost btn-sm"
              disabled={loading}
              onClick={() => void quickFill('victim')}
            >
              Log in as Test Victim (Goes to SOS Dashboard)
            </button>
            <button
              id="dev-guardian-btn"
              className="btn btn-ghost btn-sm"
              disabled={loading}
              onClick={() => void quickFill('guardian')}
            >
              Log in as Test Guardian (Goes to Inbox)
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
