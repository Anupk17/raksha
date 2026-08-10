# Technical Design — Guardian Network UI

## Overview

Four targeted changes to existing code plus one new screen. Most of the
Guardian Network UI already exists and works. This design covers only the
delta.

| Change | Type | File(s) |
|---|---|---|
| Live "updated Xs ago" counter | Bug fix | `PingCard.tsx` |
| History nav link + onDuty badge | Additive | `GuardianInboxScreen.tsx`, `useGuardianPings.ts` |
| Dev location seeding button | Additive | `GuardianInboxScreen.tsx` |
| Guardian History screen | New | `GuardianHistoryScreen.tsx` |
| Route registration | Additive | `App.tsx` |

---

## Change 1 — PingCard: live "updated Xs ago" counter

### Current behaviour

`lastUpdate` is a `Date | null` stored in `useState`. The JSX renders:

```tsx
`Live · updated ${Math.round((Date.now() - lastUpdate.getTime()) / 1000)}s ago`
```

This string is computed at render time. Because nothing triggers a re-render
after `lastUpdate` is set, the counter freezes at whatever value it had
when the Firestore `onSnapshot` last fired.

### Fix

Add a `tick` state value incremented every 10 seconds:

```typescript
const [, setTick] = useState(0)
useEffect(() => {
  const id = setInterval(() => setTick(t => t + 1), 10_000)
  return () => clearInterval(id)
}, [])
```

`tick` is not rendered — it exists only to force a re-render so
`Date.now()` is re-evaluated in the "updated Xs ago" string.

This is the minimal change. No prop changes, no new state shape.

---

## Change 2 — useGuardianPings: expose onDuty

### Current behaviour

`GuardianPingsState` does not include `onDuty`. The `GuardianInboxScreen`
cannot know whether the guardian is on or off duty.

### Fix

Add `onDuty: boolean` to the state interface:

```typescript
interface GuardianPingsState {
  guardianStatus: GuardianStatus
  pings:          GuardianPing[]
  loading:        boolean
  error:          string | null
  onDuty:         boolean          // ← new
}
```

Read it from the guardian document in the init function:

```typescript
const onDuty = guardianSnap.exists()
  ? (guardianSnap.data()['onDuty'] as boolean ?? true)
  : true
```

Pass it through all `setState` calls. Default `true` (guardians are
on-duty by default; the field is always written by `quickFill`).

---

## Change 3 — GuardianInboxScreen: history link + onDuty badge + dev button

### Nav bar change

Add a "History" link next to the existing "Home" link:

```tsx
<Link to="/guardian-history" className="nav-link">History</Link>
```

### onDuty badge change

Replace the single chip with a conditional:

```tsx
{guardianStatus === 'verified' && (
  onDuty
    ? <span className="chip chip-green">● On duty</span>
    : <span className="chip chip-amber">● Off duty</span>
)}
```

### Dev location seeding button

Shown only when `import.meta.env.VITE_USE_EMULATOR === 'true'` AND
`guardianStatus === 'verified'`:

```tsx
{import.meta.env.VITE_USE_EMULATOR === 'true' && guardianStatus === 'verified' && (
  <div className="banner banner-warning" role="note" style={{ marginBottom: '1rem' }}>
    <p className="text-sm" style={{ marginBottom: '0.5rem' }}>
      🔧 Dev: Guardian location is seeded to Bengaluru. SOS pings only appear
      if the victim's GPS is within 10km of that point. Tap below to update
      to your real location.
    </p>
    <button
      className="btn btn-ghost"
      style={{ padding: '0.4rem 0.75rem', fontSize: '0.875rem', width: 'auto' }}
      onClick={handleSeedLocation}
    >
      Seed guardian at my location
    </button>
  </div>
)}
```

`handleSeedLocation` in the screen component:

```typescript
async function handleSeedLocation() {
  navigator.geolocation.getCurrentPosition(async (pos) => {
    await setDoc(doc(db, 'guardians', uid), {
      currentLocation: { latitude: pos.coords.latitude, longitude: pos.coords.longitude },
      lastLocationUpdate: new Date(),
    }, { merge: true })
  })
}
```

---

## Change 4 — GuardianHistoryScreen (new)

### Route

`/guardian-history`

### Data loading

Two separate `getDocs` calls (not `onSnapshot` — history doesn't need
real-time updates):

```typescript
const [acceptedSnap, declinedSnap] = await Promise.all([
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
])
```

The guardian document is loaded separately:

```typescript
const guardianSnap = await getDoc(doc(db, 'guardians', uid))
```

All three calls are fired in a single `Promise.all` for efficiency:

```typescript
const [acceptedSnap, declinedSnap, guardianSnap] = await Promise.all([...])
```

### Deserialization

Each ping doc is mapped through a `deserializeHistoryItem` function:

```typescript
interface HistoryItem {
  pingId:               string
  response:             'accepted' | 'declined'
  sentAt:               Date
  respondedAt:          Date       // always non-null for responded pings
  distanceAtPingMeters: number
}

function deserializeHistoryItem(d: DocumentData): HistoryItem | null {
  try {
    const sentAtRaw      = d['sentAt']
    const respondedAtRaw = d['respondedAt']
    const sentAt      = toDate(sentAtRaw)
    const respondedAt = toDate(respondedAtRaw)
    if (!sentAt || !respondedAt) return null
    return {
      pingId:               d['pingId']               as string,
      response:             d['response']              as 'accepted' | 'declined',
      sentAt,
      respondedAt,
      distanceAtPingMeters: d['distanceAtPingMeters'] as number,
    }
  } catch { return null }
}
```

`toDate` is inlined in this file (4 lines, same logic as `evidenceTimestamp.ts`):

```typescript
function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof (value as { toDate?: unknown }).toDate === 'function')
    return (value as { toDate(): Date }).toDate()
  return null
}
```

Items from both queries are merged and sorted by `respondedAt` descending:

```typescript
const items = [...acceptedItems, ...declinedItems]
  .sort((a, b) => b.respondedAt.getTime() - a.respondedAt.getTime())
```

### responseStats display

```typescript
interface GuardianStats {
  totalPings:              number
  respondedCount:          number
  avgResponseTimeSeconds:  number
}
```

Read from `guardianSnap.data()['responseStats']`. If the field is missing,
default to `{ totalPings: 0, respondedCount: 0, avgResponseTimeSeconds: 0 }`.

Computed display values:
```typescript
const responseRate = stats.totalPings > 0
  ? `${Math.round((stats.respondedCount / stats.totalPings) * 100)}%`
  : '—'

const avgTime = stats.respondedCount > 0
  ? stats.avgResponseTimeSeconds < 60
    ? `${Math.round(stats.avgResponseTimeSeconds)}s`
    : `${Math.floor(stats.avgResponseTimeSeconds / 60)}m ${Math.round(stats.avgResponseTimeSeconds % 60)}s`
  : '—'
```

### Response time per item

```typescript
const responseTimeSecs = Math.round(
  (item.respondedAt.getTime() - item.sentAt.getTime()) / 1000
)
const responseTimeLabel = responseTimeSecs < 60
  ? `${responseTimeSecs}s`
  : `${Math.floor(responseTimeSecs / 60)}m ${responseTimeSecs % 60}s`
```

### Component state

Single `useState`:

```typescript
type HistoryState =
  | { kind: 'loading' }
  | { kind: 'loaded'; items: HistoryItem[]; stats: GuardianStats }
  | { kind: 'error'; message: string }
```

No real-time listener — `getDocs` on mount only. No teardown needed.

### Layout

```
screen
├── nav-bar: "RAKSHA" | ← Inbox | Home
├── h1: "Response History"
├── Stats card (always shown when loaded, even if 0s)
│   ├── Total pings: N
│   ├── Responded: N
│   ├── Response rate: X%
│   └── Avg response time: Xs
├── loading spinner (kind === 'loading')
├── error banner (kind === 'error')
├── empty state card (kind === 'loaded' && items.length === 0)
└── item cards sorted by respondedAt DESC
    ├── chip: green "✓ Accepted" | grey "✗ Declined"
    ├── "X km away at alert time"
    ├── "Responded: <date> <time>"
    └── "Responded in Xs"
```

---

## Change 5 — App.tsx routing

Add one import and one route:

```tsx
import { GuardianHistoryScreen } from './screens/GuardianHistoryScreen'
```

```tsx
<Route path="/guardian-history" element={<GuardianHistoryScreen />} />
```

Inside the `<RequireAuth>` block, alongside the existing `/guardian-inbox`.

---

## Firestore Index Requirements

The history queries (`guardianId == uid AND response == 'accepted'`) and
(`guardianId == uid AND response == 'declined'`) both use two equality
filters. Firestore can handle two equality `where` clauses without a
composite index. No new index is required.

---

## Privacy Compliance

The Guardian History screen only displays:
- The guardian's own response behaviour
- Distance (a scalar, not coordinates — does not reveal victim location)
- Timestamps of the guardian's own actions

It does NOT display:
- Victim UID, name, or email
- Victim location (coordinates or even neighbourhood)
- Session ID is stored on the ping document but is not rendered in the UI

---

## Design Decisions

### Why two queries instead of `!=` or `in` filter for history?

Firestore `!=` and `in` operators require a composite index when combined
with `orderBy` on a different field. The two-query approach avoids declaring
and deploying that index for the initial emulator-only implementation.

**This is a dev-convenience shortcut, not the correct long-term path.**

The cleaner production query is a single `in` filter with server-side ordering:

```typescript
getDocs(query(
  collection(db, 'guardian_pings'),
  where('guardianId', '==', uid),
  where('response', 'in', ['accepted', 'declined']),
  orderBy('respondedAt', 'desc'),
))
```

This requires one composite index in `firestore.indexes.json`:

```json
{
  "collectionGroup": "guardian_pings",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "guardianId",  "order": "ASCENDING"  },
    { "fieldPath": "response",    "order": "ASCENDING"  },
    { "fieldPath": "respondedAt", "order": "DESCENDING" }
  ]
}
```

**TODO before production**: replace the two-query merge with the single `in`
query above, add the composite index to `firestore.indexes.json`, and deploy
with `firebase deploy --only firestore:indexes`. The result set, sort order,
and deduplication behaviour are identical — the only change is one fewer
round-trip to Firestore.

### Why `getDocs` (not `onSnapshot`) for history?

History is immutable — once a ping is responded to, `respondedAt` and
`response` never change. Real-time updates add no value and waste a
persistent WebSocket connection.

### Why inline `toDate` instead of importing from `evidenceTimestamp.ts`?

`evidenceTimestamp.ts` lives in `utils/` and the import would work fine.
The inline version is 4 lines and avoids a cross-feature dependency for a
trivial conversion. Either approach is acceptable; inlining is chosen for
isolation.
