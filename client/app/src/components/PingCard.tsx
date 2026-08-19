/**
 * PingCard — displays a single pending guardian ping with:
 *  - Live Leaflet map showing the victim's real-time location (blue neon dot)
 *  - "Open in Maps" navigation link
 *  - Live-updating distance as victim moves
 *  - Accept / Decline actions via respondToGuardianPing callable
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { httpsCallable } from 'firebase/functions'
import { doc, onSnapshot } from 'firebase/firestore'
import type * as L from 'leaflet'
import { db, fns } from '../firebase'
import type { GuardianPing } from '../hooks/useGuardianPings'

// Leaflet runtime is loaded via CDN in index.html — grab it from window
const getL = (): typeof L => (window as unknown as { L: typeof L }).L

interface Props { ping: GuardianPing }
interface VictimLocation { latitude: number; longitude: number }

function formatElapsed(sentAt: Date): string {
  const secs = Math.floor((Date.now() - sentAt.getTime()) / 1000)
  if (secs < 60)  return 'Just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60)  return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hrs  = Math.floor(mins / 60)
  return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m away`
  return `${(meters / 1000).toFixed(1)} km away`
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── Leaflet map component ────────────────────────────────────────────────────
function VictimMap({ victimLoc }: { victimLoc: VictimLocation }) {
  const mapRef     = useRef<HTMLDivElement>(null)
  const leafletRef = useRef<L.Map | null>(null)
  const markerRef  = useRef<L.CircleMarker | null>(null)

  // Initialise map once on mount
  useEffect(() => {
    if (!mapRef.current) return
    if (leafletRef.current) return // already initialised
    const LLib = getL()
    if (!LLib) return

    const map = LLib.map(mapRef.current, {
      center: [victimLoc.latitude, victimLoc.longitude],
      zoom: 16,
      zoomControl: true,
      attributionControl: false,
    })

    LLib.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(map)

    // Blue neon dot for victim
    const marker = LLib.circleMarker([victimLoc.latitude, victimLoc.longitude], {
      radius: 10,
      color: '#00c6ff',
      fillColor: '#00c6ff',
      fillOpacity: 0.9,
      weight: 3,
    }).addTo(map)
    marker.bindPopup('<b>🆘 Victim location</b><br>Live tracking active').openPopup()

    leafletRef.current = map
    markerRef.current  = marker

    return () => {
      map.remove()
      leafletRef.current = null
      markerRef.current  = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update marker + pan map whenever victimLoc changes
  useEffect(() => {
    const map    = leafletRef.current
    const marker = markerRef.current
    if (!map || !marker) return
    const latlng: [number, number] = [victimLoc.latitude, victimLoc.longitude]
    marker.setLatLng(latlng)
    map.panTo(latlng, { animate: true, duration: 0.8 })
  }, [victimLoc.latitude, victimLoc.longitude])

  return (
    <div
      ref={mapRef}
      style={{ width: '100%', height: '240px', borderRadius: '8px', overflow: 'hidden' }}
    />
  )
}

// ── PingCard ─────────────────────────────────────────────────────────────────
export function PingCard({ ping }: Props) {
  const [responding,   setResponding]  = useState(false)
  // Pre-seed responded from Firestore — ping.response may already be 'accepted'
  // if this guardian responded in a previous render cycle and the query now
  // returns it with the updated response field.
  const [responded,    setResponded]   = useState(ping.response === 'accepted')
  const [alreadyDone,  setAlreadyDone] = useState(false)
  const [error,        setError]       = useState<string | null>(null)
  const [victimLoc,    setVictimLoc]   = useState<VictimLocation | null>(null)
  const [liveDistance, setLiveDistance] = useState<number>(ping.distanceAtPingMeters)
  const [lastUpdate,   setLastUpdate]  = useState<Date | null>(null)
  const guardianLocRef = useRef<{ latitude: number; longitude: number } | null>(null)

  // Tick every 10 s to keep "X minutes ago" and "updated Xs ago" labels current.
  // Nothing is stored in `tick` — it exists only to force a re-render so
  // Date.now() is re-evaluated in the label expressions below.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  // elapsed is re-derived on every tick rather than stored separately,
  // since the 10s tick already forces re-renders.
  const elapsed = formatElapsed(ping.sentAt)

  // Watch guardian's own location for live distance calculation
  useEffect(() => {
    if (!navigator.geolocation) return
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        guardianLocRef.current = { latitude: pos.coords.latitude, longitude: pos.coords.longitude }
      },
      undefined,
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 5000 }
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  // Subscribe to the SOS session document for live victim location
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'sosSessions', ping.sosSessionId),
      (snap) => {
        if (!snap.exists()) return
        const data = snap.data()
        const loc = data['location']?.current as VictimLocation | undefined
        if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
          setVictimLoc(loc)
          setLastUpdate(new Date())
          // Recalculate live distance using guardian's current position
          if (guardianLocRef.current) {
            const d = haversineMeters(
              guardianLocRef.current.latitude,
              guardianLocRef.current.longitude,
              loc.latitude,
              loc.longitude
            )
            setLiveDistance(Math.round(d))
          }
        }
      },
      (err) => console.error('[PingCard] onSnapshot error:', err)
    )
    return () => unsub()
  }, [ping.sosSessionId])

  const respond = useCallback(async (response: 'accepted' | 'declined') => {
    setResponding(true)
    setError(null)
    try {
      const fn = httpsCallable<unknown, { success: boolean; alreadyResponded?: boolean }>(
        fns, 'respondToGuardianPing'
      )
      const result = await fn({ pingId: ping.pingId, response })
      if (result.data.alreadyResponded) {
        setAlreadyDone(true)
      } else {
        setResponded(true)
      }
    } catch (err: unknown) {
      setResponding(false)
      const msg = err instanceof Error ? err.message : ''
      setError(
        import.meta.env.VITE_USE_EMULATOR === 'true'
          ? `Response failed: ${msg}`
          : 'Response failed. Please try again.'
      )
    }
  }, [ping.pingId])

  if (alreadyDone) {
    return (
      <div className="card" style={{ opacity: 0.6 }}>
        <span className="chip chip-green">✓ Already responded</span>
      </div>
    )
  }

  if (responded) {
    return (
      <div className="card" style={{ borderLeft: '3px solid #2e7d32', padding: '1rem' }}>
        <div className="row-between" style={{ marginBottom: '0.5rem' }}>
          <span className="chip chip-green">✓ You're on your way</span>
          <span className="chip chip-red" style={{ fontSize: '0.75rem' }}>Active emergency</span>
        </div>
        <p className="text-muted text-sm" style={{ marginBottom: '0.75rem' }}>
          Keep this open — you can still see the victim's live location below.
          Other guardians may also respond.
        </p>

        {/* Distance + live update */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '1.25rem' }}>📍</span>
          <div>
            <p style={{ fontWeight: 700, fontSize: '1.1rem' }}>{formatDistance(liveDistance)}</p>
            <p className="text-muted text-xs">
              {lastUpdate
                ? `Live · updated ${Math.round((Date.now() - lastUpdate.getTime()) / 1000)}s ago`
                : 'At time of alert'}
            </p>
          </div>
          {victimLoc && (
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${victimLoc.latitude},${victimLoc.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                background: '#1565c0',
                color: '#fff',
                borderRadius: '6px',
                padding: '0.35rem 0.75rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              🗺 Navigate
            </a>
          )}
        </div>

        {/* Live Map stays visible */}
        {victimLoc && (
          <div style={{ position: 'relative' }}>
            <VictimMap victimLoc={victimLoc} />
            <div style={{
              position: 'absolute', top: '0.5rem', left: '0.5rem',
              background: 'rgba(0,198,255,0.15)', border: '1.5px solid #00c6ff',
              borderRadius: '6px', padding: '0.2rem 0.5rem',
              fontSize: '0.7rem', fontWeight: 600, color: '#00c6ff',
              backdropFilter: 'blur(4px)',
            }}>
              ● Live tracking
            </div>
          </div>
        )}

        <p className="text-muted text-xs" style={{ marginTop: '0.75rem', textAlign: 'center' }}>
          This card will close when the victim cancels the SOS.
        </p>
      </div>
    )
  }

  return (
    <div className="card" style={{ borderLeft: '3px solid #d32f2f', padding: '0' }}>
      {/* Header */}
      <div style={{ padding: '1rem 1rem 0.75rem' }}>
        <div className="row-between" style={{ marginBottom: '0.5rem' }}>
          <div>
            <p style={{ fontWeight: 700, fontSize: '1.05rem' }}>🚨 Emergency Alert</p>
            <p className="text-muted text-sm" style={{ marginTop: '0.15rem' }}>{elapsed}</p>
          </div>
          <span className="chip chip-red">Urgent</span>
        </div>

        {/* Distance row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '1.25rem' }}>📍</span>
          <div>
            <p style={{ fontWeight: 700, fontSize: '1.1rem' }}>{formatDistance(liveDistance)}</p>
            <p className="text-muted text-xs">
              {lastUpdate
                ? `Live · updated ${Math.round((Date.now() - lastUpdate.getTime()) / 1000)}s ago`
                : 'At time of alert'}
            </p>
          </div>
          {victimLoc && (
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${victimLoc.latitude},${victimLoc.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                background: '#1565c0',
                color: '#fff',
                borderRadius: '6px',
                padding: '0.35rem 0.75rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              🗺 Open in Maps
            </a>
          )}
        </div>
      </div>

      {/* Live Map */}
      {victimLoc ? (
        <div style={{ padding: '0 1rem 0.75rem' }}>
          <div style={{ position: 'relative' }}>
            <VictimMap victimLoc={victimLoc} />
            {/* Blue neon pulse ring overlay */}
            <div style={{
              position: 'absolute',
              top: '0.5rem',
              left: '0.5rem',
              background: 'rgba(0,198,255,0.15)',
              border: '1.5px solid #00c6ff',
              borderRadius: '6px',
              padding: '0.2rem 0.5rem',
              fontSize: '0.7rem',
              fontWeight: 600,
              color: '#00c6ff',
              backdropFilter: 'blur(4px)',
            }}>
              ● Live tracking
            </div>
          </div>
        </div>
      ) : (
        <div style={{
          margin: '0 1rem 0.75rem',
          height: '100px',
          borderRadius: '8px',
          background: '#f5f5f7',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#888',
          fontSize: '0.85rem',
        }}>
          <div style={{ textAlign: 'center' }}>
            <div className="spinner" style={{ width: '20px', height: '20px', margin: '0 auto 0.5rem' }} />
            Fetching victim location…
          </div>
        </div>
      )}

      {error && <p className="field-error" style={{ padding: '0 1rem', marginBottom: '0.75rem' }}>{error}</p>}

      {/* Actions */}
      <div className="stack-sm" style={{ padding: '0 1rem 1rem' }}>
        <button
          id={`accept-${ping.pingId}`}
          className="btn btn-primary"
          disabled={responding}
          onClick={() => void respond('accepted')}
        >
          {responding ? '…' : '✓ Respond — I\'m on my way'}
        </button>
        <button
          id={`decline-${ping.pingId}`}
          className="btn btn-ghost"
          disabled={responding}
          onClick={() => void respond('declined')}
        >
          Decline
        </button>
      </div>
    </div>
  )
}
