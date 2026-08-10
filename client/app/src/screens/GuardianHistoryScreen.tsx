/**
 * GuardianHistoryScreen — a verified guardian's past ping responses + stats.
 *
 * DATA LOADING:
 *   Two separate getDocs queries (response=='accepted', response=='declined')
 *   are merged and sorted by respondedAt DESC client-side. This avoids
 *   a composite index for the current emulator-only phase.
 *
 *   TODO (pre-production): replace with a single `in` query + composite index:
 *     where('response', 'in', ['accepted','declined']) + orderBy('respondedAt','desc')
 *   See design.md §"Why two queries" for the index definition.
 *
 * PRIVACY:
 *   No victim UID, name, location, or session details are displayed.
 *   Only the guardian's own response behaviour and aggregate stats.
 *
 * TIMESTAMP RULE:
 *   All timestamps deserialized to native Date at the boundary via toDate().
 *   No Firestore Timestamp objects enter component state.
 *
 * Design: §Change 4 — GuardianHistoryScreen
 * Requirements: 2.1–2.7
 */
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  collection, doc, getDoc, getDocs, query, where,
  type DocumentData, type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../contexts/AuthContext'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryItem {
  pingId:               string
  response:             'accepted' | 'declined'
  sentAt:               Date
  respondedAt:          Date      // always non-null for responded pings
  distanceAtPingMeters: number
}

interface GuardianStats {
  totalPings:             number
  respondedCount:         number
  avgResponseTimeSeconds: number
}

type HistoryState =
  | { kind: 'loading' }
  | { kind: 'loaded'; items: HistoryItem[]; stats: GuardianStats }
  | { kind: 'error'; message: string }

// ---------------------------------------------------------------------------
// Helpers — inlined to avoid cross-feature dependency
// ---------------------------------------------------------------------------

/** Convert Firestore Timestamp, native Date, or ISO string → native Date | null */
function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof (value as { toDate?: unknown }).toDate === 'function')
    return (value as { toDate(): Date }).toDate()
  if (typeof value === 'string') { const d = new Date(value); return isNaN(d.getTime()) ? null : d }
  return null
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1)} km`
}

function formatResponseTime(secs: number): string {
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function formatAvgTime(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
}

// ---------------------------------------------------------------------------
// StatCell — local display component
// ---------------------------------------------------------------------------

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      background: 'var(--surface-2)',
      borderRadius: 'var(--radius-sm)',
      padding: '0.75rem',
    }}>
      <p className="text-muted text-xs" style={{ marginBottom: '0.25rem' }}>{label}</p>
      <p style={{ fontWeight: 700, fontSize: '1.1rem' }}>{value}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Deserializer
// ---------------------------------------------------------------------------

function deserializeHistoryItem(d: QueryDocumentSnapshot<DocumentData>): HistoryItem | null {
  try {
    const raw         = d.data()
    const sentAt      = toDate(raw['sentAt'])
    const respondedAt = toDate(raw['respondedAt'])
    if (!sentAt || !respondedAt) return null
    return {
      pingId:               raw['pingId']               as string,
      response:             raw['response']              as 'accepted' | 'declined',
      sentAt,
      respondedAt,
      distanceAtPingMeters: raw['distanceAtPingMeters'] as number,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GuardianHistoryScreen() {
  const { user } = useAuth()
  const uid = user!.uid

  const [historyState, setHistoryState] = useState<HistoryState>({ kind: 'loading' })

  useEffect(() => {
    async function load() {
      try {
        // Two equality queries to avoid needing a composite index for !=.
        // See design.md §"Why two queries" for the production migration path.
        const [acceptedSnap, declinedSnap, guardianSnap] = await Promise.all([
          getDocs(query(
            collection(db, 'guardian_pings'),
            where('guardianId', '==', uid),
            where('response', '==', 'accepted'),
          )),
          getDocs(query(
            collection(db, 'guardian_pings'),
            where('guardianId', '==', uid),
            where('response', '==', 'declined'),
          )),
          getDoc(doc(db, 'guardians', uid)),
        ])

        // Merge, filter malformed docs, sort by respondedAt DESC
        const items: HistoryItem[] = [
          ...acceptedSnap.docs.map(deserializeHistoryItem),
          ...declinedSnap.docs.map(deserializeHistoryItem),
        ]
          .filter((item): item is HistoryItem => item !== null)
          .sort((a, b) => b.respondedAt.getTime() - a.respondedAt.getTime())

        // responseStats — default to zero if field absent or doc missing
        const rawStats = guardianSnap.exists()
          ? (guardianSnap.data()['responseStats'] as Partial<GuardianStats> | undefined)
          : undefined

        const stats: GuardianStats = {
          totalPings:             rawStats?.totalPings             ?? 0,
          respondedCount:         rawStats?.respondedCount         ?? 0,
          avgResponseTimeSeconds: rawStats?.avgResponseTimeSeconds ?? 0,
        }

        setHistoryState({ kind: 'loaded', items, stats })
      } catch (err) {
        const message = import.meta.env.VITE_USE_EMULATOR === 'true'
          ? `Failed to load history: ${(err as Error).message}`
          : 'Failed to load history. Please try again.'
        setHistoryState({ kind: 'error', message })
      }
    }

    void load()
  }, [uid])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="screen">
      {/* Nav */}
      <nav className="nav-bar">
        <span className="nav-logo">🛡️ RAKSHA</span>
        <div className="nav-links">
          <Link to="/guardian-inbox" className="nav-link">← Inbox</Link>
          <Link to="/home" className="nav-link">Home</Link>
        </div>
      </nav>

      <h1 style={{ marginBottom: '0.25rem' }}>Response History</h1>
      <p className="text-muted text-sm" style={{ marginBottom: '1.75rem' }}>
        Your past ping responses and performance stats.
      </p>

      {/* Loading */}
      {historyState.kind === 'loading' && (
        <div className="screen-centered" style={{ minHeight: 'unset', paddingTop: '2rem' }}>
          <div className="spinner" role="status" aria-label="Loading history…" />
        </div>
      )}

      {/* Error */}
      {historyState.kind === 'error' && (
        <div className="banner banner-error" role="alert">{historyState.message}</div>
      )}

      {/* Loaded */}
      {historyState.kind === 'loaded' && (() => {
        const { items, stats } = historyState

        const responseRate = stats.totalPings > 0
          ? `${Math.round((stats.respondedCount / stats.totalPings) * 100)}%`
          : '—'

        const avgTime = stats.respondedCount > 0
          ? formatAvgTime(stats.avgResponseTimeSeconds)
          : '—'

        return (
          <div className="stack">
            {/* Stats card — always shown */}
            <div className="card">
              <h2 style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>My Stats</h2>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '0.75rem',
              }}>
                <StatCell label="Total pings"        value={String(stats.totalPings)} />
                <StatCell label="Responded"           value={String(stats.respondedCount)} />
                <StatCell label="Response rate"       value={responseRate} />
                <StatCell label="Avg response time"   value={avgTime} />
              </div>
            </div>

            {/* History list heading */}
            <p className="text-muted text-sm" style={{ marginBottom: '-0.25rem' }}>
              {items.length > 0
                ? `${items.length} past response${items.length !== 1 ? 's' : ''}`
                : ''}
            </p>

            {/* Empty state */}
            {items.length === 0 && (
              <div className="card" style={{ textAlign: 'center', padding: '2rem 1rem' }}>
                <p style={{ fontSize: '1.75rem', marginBottom: '0.75rem' }}>📋</p>
                <p className="text-muted">
                  No responses yet. Accepted or declined pings will appear here.
                </p>
              </div>
            )}

            {/* History items */}
            {items.map(item => {
              const responseTimeSecs = Math.round(
                (item.respondedAt.getTime() - item.sentAt.getTime()) / 1000
              )
              return (
                <div key={item.pingId} className="card stack-sm">
                  <div className="row-between">
                    {item.response === 'accepted'
                      ? <span className="chip chip-green">✓ Accepted</span>
                      : (
                        <span className="chip" style={{
                          background: 'var(--surface-3)',
                          color: 'var(--text-muted)',
                        }}>
                          ✗ Declined
                        </span>
                      )
                    }
                    <span className="text-muted text-xs">
                      Responded in {formatResponseTime(responseTimeSecs)}
                    </span>
                  </div>

                  <p className="text-muted text-sm">
                    📍 {formatDistance(item.distanceAtPingMeters)} away at alert time
                  </p>

                  <p className="text-muted text-sm">
                    {item.respondedAt.toLocaleDateString(undefined, {
                      year:   'numeric',
                      month:  'short',
                      day:    'numeric',
                      hour:   'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              )
            })}
          </div>
        )
      })()}
    </div>
  )
}
