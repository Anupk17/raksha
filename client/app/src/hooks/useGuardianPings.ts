/**
 * useGuardianPings — manages the guardian inbox data flow.
 *
 * Design: frontend_design.md §6.3
 * Requirements: frontend_requirements.md §4
 *
 * Guardrail: all Firestore Timestamp fields converted via .toDate()
 * before entering component state (Section 6).
 */
import { useEffect, useState } from 'react'
import {
  doc, getDoc, setDoc, collection, query, where, onSnapshot,
  type Timestamp,
} from 'firebase/firestore'
import { db, auth } from '../firebase'

export interface GuardianPing {
  pingId: string
  sosSessionId: string
  guardianId: string
  sentAt: Date          // converted from Firestore Timestamp — NEVER Firestore Timestamp
  respondedAt: Date | null
  response: 'accepted' | 'declined' | 'no_response'
  distanceAtPingMeters: number
}

export type GuardianStatus = 'loading' | 'verified' | 'not-registered'

interface GuardianPingsState {
  guardianStatus: GuardianStatus
  pings: GuardianPing[]
  loading: boolean
  error: string | null
  onDuty: boolean
}

export function useGuardianPings(uid: string) {
  const [state, setState] = useState<GuardianPingsState>({
    guardianStatus: 'loading',
    pings: [],
    loading: true,
    error: null,
    onDuty: true,
  })

  useEffect(() => {
    if (!uid) return

    let unsub: (() => void) | null = null

    async function init() {
      // onDuty is hoisted out of the try block so it's in scope for the
      // onSnapshot callback below (which closes over it after init resolves).
      let onDuty = true

      // 1. Check guardian verification status
      try {
        const guardianSnap = await getDoc(doc(db, 'guardians', uid))
        const authEmail = auth.currentUser?.email ?? ''
        const isGuardianEmail = authEmail.toLowerCase().includes('guardian')

        // Read onDuty from existing doc (default true if absent)
        onDuty = guardianSnap.exists()
          ? (guardianSnap.data()['onDuty'] as boolean ?? true)
          : true

        if (!guardianSnap.exists() && isGuardianEmail) {
          // Seed with real GPS if available, fall back to Bengaluru only if denied
          const seedLocation = await new Promise<{ latitude: number; longitude: number }>((resolve) => {
            if (!navigator.geolocation) {
              // Hardcoded to south Bengaluru — matches the OnePlus CPH2585 test device's
              // consistent GPS fix. Update this if testing from a different location.
              resolve({ latitude: 12.8649, longitude: 77.5470 })
              return
            }
            navigator.geolocation.getCurrentPosition(
              (pos) => {
                console.log('[useGuardianPings] Seed GPS fix:', pos.coords.latitude, pos.coords.longitude, 'accuracy:', pos.coords.accuracy, 'm')
                resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude })
              },
              () => {
                console.warn('[useGuardianPings] GPS denied — using hardcoded test coords')
                resolve({ latitude: 12.8649, longitude: 77.5470 })
              },
              // enableHighAccuracy forces GPS chip, not WiFi; maximumAge:0 prevents
              // stale cached WiFi fixes that are 14km off
              { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
            )
          })
          await setDoc(doc(db, 'guardians', uid), {
            guardianId:         uid,
            verificationStatus: 'verified',
            onDuty:             true,
            responseStats:      { totalPings: 0, respondedCount: 0, avgResponseTimeSeconds: 0 },
            currentLocation:    seedLocation,
            lastLocationUpdate: new Date(),
            verificationDocs:   [],
          })
        } else if (
          (!guardianSnap.exists() || guardianSnap.data()['verificationStatus'] !== 'verified') &&
          !isGuardianEmail
        ) {
          setState({ guardianStatus: 'not-registered', pings: [], loading: false, error: null, onDuty: false })
          return
        } else if (guardianSnap.exists()) {
          // Do NOT auto-refresh location on every mount — the PC browser's WiFi
          // geolocation is inaccurate (14+ km off). Location is updated only when
          // the user explicitly taps "Seed guardian at my location" in the dev banner.
        }
      } catch (err) {
        console.error('[useGuardianPings] Init check failed:', err)
        setState((s) => ({ ...s, guardianStatus: 'not-registered', loading: false, error: 'Could not verify guardian status.', onDuty: false }))
        return
      }

      // 2. Open onSnapshot for pending AND accepted pings so accepted cards
      //    remain visible until the victim cancels (Req: multiple guardians
      //    can converge; card must not disappear after responding).
      const q = query(
        collection(db, 'guardian_pings'),
        where('guardianId', '==', uid),
        where('response', 'in', ['no_response', 'accepted']),
      )

      unsub = onSnapshot(
        q,
        (snap) => {
          const pings: GuardianPing[] = snap.docs.map((d) => {
            const data = d.data()
            return {
              pingId:               d.id,
              sosSessionId:         data['sosSessionId'] as string,
              guardianId:           data['guardianId'] as string,
              // Section 6 guardrail: .toDate() converts Firestore Timestamp → native Date
              sentAt:               (data['sentAt'] as Timestamp).toDate(),
              respondedAt:          data['respondedAt']
                ? (data['respondedAt'] as Timestamp).toDate()
                : null,
              response:             data['response'] as GuardianPing['response'],
              distanceAtPingMeters: data['distanceAtPingMeters'] as number,
            }
          })
          setState({ guardianStatus: 'verified', pings, loading: false, error: null, onDuty })
        },
        (err) => {
          setState((s) => ({ ...s, loading: false, error: `Connection error: ${err.code}` }))
        },
      )
    }

    void init()

    return () => {
      unsub?.()
    }
  }, [uid])

  return state
}
