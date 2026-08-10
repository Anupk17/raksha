/**
 * useCountdown — manages the full SOS session lifecycle from the countdown screen.
 *
 * Design: frontend_design.md §6.2
 * Requirements: frontend_requirements.md §3
 *
 * Key Section 6 guardrail enforcements:
 * - triggeredAt arrives as a Date from location.state — never re-constructed here
 * - syncedAt = new Date() at the moment createSOSSession is called (not at mount)
 * - Timer driven by Date.now() delta, not setInterval tick count
 * - onSnapshot listener torn down in cleanup
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { doc, onSnapshot, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, fns } from '../firebase'
import { getCurrentHashedLocation } from './useGeolocation'

function truncate3dp(v: number): number {
  return Math.trunc(v * 1000) / 1000
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  )
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export type CountdownStatus =
  | 'pending'    // awaiting createSOSSession
  | 'countdown'  // 10 → 0 timer running
  | 'active'     // SOS escalated
  | 'cancelled'  // cancelled (local or server-side)
  | 'error'      // createSOSSession failed

interface CountdownState {
  secondsLeft: number
  status: CountdownStatus
  sessionId: string | null
  locationWarning: boolean
  error: string | null
}

interface CreateSOSResult { sessionId: string; status: string }

export function useCountdown(triggeredAt: Date, triggerType: string) {
  const [state, setState] = useState<CountdownState>({
    secondsLeft: 10,
    status: 'pending',
    sessionId: null,
    locationWarning: false,
    error: null,
  })

  const rafRef     = useRef<number | null>(null)
  const unsubRef   = useRef<(() => void) | null>(null)
  const sessionRef = useRef<string | null>(null)
  const cancelledRef = useRef(false)

  // ── Stop the rAF timer loop ───────────────────────────────────────────────
  const stopTimer = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // ── Start rAF-driven timer ────────────────────────────────────────────────
  const startTimer = useCallback(() => {
    const tick = () => {
      const elapsed = (Date.now() - triggeredAt.getTime()) / 1000
      const secs = Math.max(0, Math.ceil(10 - elapsed))
      setState((s) => ({ ...s, secondsLeft: secs }))
      if (secs > 0) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [triggeredAt])

  // ── Main effect — create session + open listener ──────────────────────────
  useEffect(() => {
    let isMounted = true
    let watchId: number | null = null

    async function init() {
      // 1. Get geolocation (CountdownScreen calls this on mount per design §6.2)
      const location = await getCurrentHashedLocation()
      if (!isMounted) return

      if (!location) {
        setState((s) => ({ ...s, locationWarning: true }))
      }

      // 2. Call createSOSSession
      const deviceInfo = navigator.userAgent.slice(0, 200)
      const createFn = httpsCallable<unknown, CreateSOSResult>(fns, 'createSOSSession')
      let sessionId: string
      let initialStatus: string

      try {
        const result = await createFn({
          triggerType,
          triggeredAt: triggeredAt.toISOString(),   // ← Section 6: Date → ISO string once
          syncedAt:    new Date().toISOString(),     // ← at call time, not mount time
          location,
          deviceInfo,
        })
        sessionId     = result.data.sessionId
        initialStatus = result.data.status
      } catch (err: unknown) {
        if (!isMounted) return
        const msg = err instanceof Error ? err.message : 'Unknown error'
        setState((s) => ({ ...s, status: 'error', error: msg }))
        return
      }

      if (!isMounted) return
      sessionRef.current = sessionId

      // Late-sync: server already activated before our call returned
      if (initialStatus === 'active') {
        setState((s) => ({ ...s, status: 'active', sessionId }))
      } else {
        // 3. Start timer
        setState((s) => ({ ...s, status: 'countdown', sessionId }))
        startTimer()
      }

      // Start watching victim's location live
      if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(
          async (pos) => {
            const lat = pos.coords.latitude
            const lng = pos.coords.longitude
            const tLat = truncate3dp(lat)
            const tLng = truncate3dp(lng)
            const [latHash, lngHash] = await Promise.all([
              sha256hex(String(tLat)),
              sha256hex(String(tLng)),
            ])

            try {
              await updateDoc(doc(db, 'sosSessions', sessionId), {
                location: {
                  latHash,
                  lngHash,
                  current: { latitude: lat, longitude: lng },
                },
                updatedAt: new Date().toISOString(),
              })
            } catch (err) {
              console.error('[useCountdown] Live location update failed:', err)
            }
          },
          (err) => console.error('[useCountdown] watchPosition error:', err),
          { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
        )
      }

      // 4. Open Firestore listener for server-side status changes
      const docRef = doc(db, 'sosSessions', sessionId)
      unsubRef.current = onSnapshot(
        docRef,
        (snap) => {
          if (!snap.exists()) return
          const data = snap.data()
          const serverStatus: string = data['status']
          if (serverStatus === 'active') {
            stopTimer()
            setState((s) => ({ ...s, status: 'active' }))
          } else if (serverStatus === 'cancelled') {
            stopTimer()
            setState((s) => ({ ...s, status: 'cancelled' }))
          }
        },
        (err) => {
          // Permission errors after token expiry — surface as a banner, not a crash
          console.error('[useCountdown] onSnapshot error', err.code)
        },
      )
    }

    void init()

    return () => {
      isMounted = false
      stopTimer()
      unsubRef.current?.()
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — triggeredAt/triggerType arrive from stable navigation state

  // ── Cancel function ───────────────────────────────────────────────────────
  const cancel = useCallback(async () => {
    if (cancelledRef.current) return
    cancelledRef.current = true
    stopTimer()

    const sid = sessionRef.current
    if (!sid) return

    try {
      const cancelFn = httpsCallable(fns, 'cancelSOSSession', { timeout: 8000 })
      await cancelFn({ sessionId: sid })
      setState((s) => ({ ...s, status: 'cancelled' }))
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? ''
      if (code === 'functions/deadline-exceeded' || code === 'functions/unavailable') {
        // Emulator/network timeout — optimistically treat as cancelled
        setState((s) => ({ ...s, status: 'cancelled' }))
      } else if (code === 'functions/failed-precondition' || code === 'functions/not-found') {
        // Already escalated
        setState((s) => ({ ...s, status: 'active' }))
      } else {
        // Any other error including network — treat as cancelled for UX
        setState((s) => ({ ...s, status: 'cancelled' }))
      }
    }
  }, [stopTimer])

  return { ...state, cancel }
}
