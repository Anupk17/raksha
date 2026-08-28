import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { User } from 'firebase/auth'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { auth, db } from '../firebase'
import type { SilentActivationConfig } from '@sa/activationConfig'

interface AuthContextValue {
  user:                    User | null
  loading:                 boolean
  pinLockEnabled:          boolean
  isUnlocked:              boolean
  onboardingComplete:      boolean
  markUnlocked:            () => void
  lockApp:                 () => void
  markOnboardingComplete:  () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user:                   null,
  loading:                true,
  pinLockEnabled:         false,
  isUnlocked:             false,
  onboardingComplete:     false,
  markUnlocked:           () => {},
  lockApp:                () => {},
  markOnboardingComplete: async () => {},
})

// How long (ms) the app stays unlocked after backgrounding before requiring re-entry.
const UNLOCK_GRACE_MS = 60_000

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,               setUser]               = useState<User | null>(null)
  const [loading,            setLoading]            = useState(true)
  const [pinLockEnabled,     setPinLockEnabled]     = useState(false)
  const [isUnlocked,         setIsUnlocked]         = useState(false)
  const [onboardingComplete, setOnboardingComplete] = useState(false)

  // Track when the app was backgrounded to enforce the 60s grace period
  const backgroundedAtRef = useRef<number | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u)
      if (u) {
        // Load pinLockEnabled from silentActivationConfig
        try {
          const snap = await getDoc(doc(db, 'users', u.uid))
          if (snap.exists()) {
            const data = snap.data()
            const cfg = data['silentActivationConfig'] as SilentActivationConfig | undefined
            setPinLockEnabled(!!cfg?.pinLockEnabled)
            setOnboardingComplete(!!data['onboardingComplete'])
          }
        } catch {
          // Non-fatal — default to no PIN lock, onboarding not complete
        }
      } else {
        // User logged out — reset lock state
        setPinLockEnabled(false)
        setIsUnlocked(false)
        setOnboardingComplete(false)
      }
      setLoading(false)
    })
    return unsub
  }, [])

  // Handle app background / foreground — re-lock after grace period
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        backgroundedAtRef.current = Date.now()
      } else {
        const bg = backgroundedAtRef.current
        if (bg !== null && Date.now() - bg > UNLOCK_GRACE_MS) {
          setIsUnlocked(false)
        }
        backgroundedAtRef.current = null
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  const markUnlocked = () => setIsUnlocked(true)
  const lockApp      = () => setIsUnlocked(false)

  const markOnboardingComplete = async () => {
    setOnboardingComplete(true)
    if (!user) return
    try {
      await setDoc(doc(db, 'users', user.uid), { onboardingComplete: true }, { merge: true })
    } catch (err) {
      console.error('[AuthContext] markOnboardingComplete failed:', err)
    }
  }

  return (
    <AuthContext.Provider value={{ user, loading, pinLockEnabled, isUnlocked, onboardingComplete, markUnlocked, lockApp, markOnboardingComplete }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
