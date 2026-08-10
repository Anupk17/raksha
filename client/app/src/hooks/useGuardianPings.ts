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
          await setDoc(doc(db, 'guardians', uid), {
            guardianId:         uid,
            verificationStatus: 'verified',
            onDuty:             true,
            responseStats:      { totalPings: 0, respondedCount: 0, avgResponseTimeSeconds: 0 },
            currentLocation:    { latitude: 12.9716, longitude: 77.5946 },
            lastLocationUpdate: new Date(),
            verificationDocs:   [],
          })
        } else if (
          (!guardianSnap.exists() || guardianSnap.data()['verificationStatus'] !== 'verified') &&
          !isGuardianEmail
        ) {
          setState({ guardianStatus: 'not-registered', pings: [], loading: false, error: null, onDuty: false })
          return
        }
      } catch (err) {
        console.error('[useGuardianPings] Init check failed:', err)
        setState((s) => ({ ...s, guardianStatus: 'not-registered', loading: false, error: 'Could not verify guardian status.', onDuty: false }))
        return
      }

      // 2. Open onSnapshot for pending pings
      const q = query(
        collection(db, 'guardian_pings'),
        where('guardianId', '==', uid),
        where('response', '==', 'no_response'),
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

    // 3. Watch guardian's own location live to keep their profile current
    let watchId: number | null = null
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        async (pos) => {
          const { latitude, longitude } = pos.coords
          try {
            await setDoc(doc(db, 'guardians', uid), {
              currentLocation: { latitude, longitude },
              lastLocationUpdate: new Date(),
            }, { merge: true })
          } catch (err) {
            console.error('[useGuardianPings] Failed to update guardian location:', err)
          }
        },
        (err) => console.error('[useGuardianPings] Guardian location watch error:', err),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 5000 }
      )
    }

    return () => {
      unsub?.()
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId)
      }
    }
  }, [uid])

  return state
}
