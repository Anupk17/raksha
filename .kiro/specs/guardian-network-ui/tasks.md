# Implementation Tasks — Guardian Network UI

## Task Dependency Graph

```
Task 1 (PingCard tick fix) — independent
Task 2 (useGuardianPings onDuty) — independent
Task 3 (GuardianInboxScreen additions) — depends on Task 2 (onDuty field)
Task 4 (GuardianHistoryScreen) — independent
Task 5 (App.tsx routing) — depends on Tasks 3 and 4
Task 6 (Diagnostics + build) — depends on all prior tasks
```

Tasks 1, 2, and 4 can be implemented in parallel.
Task 3 must follow Task 2.
Task 5 must follow Tasks 3 and 4.

---

## Task 1 — PingCard: live "updated Xs ago" counter (15 min)

**File**: `client/app/src/components/PingCard.tsx`

Add a 10-second tick interval that forces re-renders so the elapsed/update
labels stay current:

```typescript
// At the top of PingCard component, alongside existing useState declarations
const [, setTick] = useState(0)

useEffect(() => {
  const id = setInterval(() => setTick(t => t + 1), 10_000)
  return () => clearInterval(id)
}, [])
```

No other changes to `PingCard.tsx`.

**Acceptance**: Open a PingCard in the browser. The "updated Xs ago" label
visibly increments every ~10 seconds without a page refresh.

---

## Task 2 — useGuardianPings: expose onDuty field (20 min)

**File**: `client/app/src/hooks/useGuardianPings.ts`

1. Add `onDuty: boolean` to `GuardianPingsState` interface
2. Read `onDuty` from guardian doc in the `init()` function after the
   `getDoc` call
3. Include `onDuty` in every `setState` call in the hook
4. Export it from the hook's return value

Key change in `init()`:

```typescript
const onDuty = guardianSnap.exists()
  ? (guardianSnap.data()['onDuty'] as boolean ?? true)
  : true
```

Update initial state:
```typescript
const [state, setState] = useState<GuardianPingsState>({
  guardianStatus: 'loading',
  pings: [],
  loading: true,
  error: null,
  onDuty: true,           // ← add
})
```

Update the `not-registered` branch setState:
```typescript
setState({ guardianStatus: 'not-registered', pings: [], loading: false, error: null, onDuty: false })
```

Update the `onSnapshot` callback setState:
```typescript
setState({ guardianStatus: 'verified', pings, loading: false, error: null, onDuty })
```

**Acceptance**: `const { onDuty } = useGuardianPings(uid)` compiles without
errors and returns `true` for the test guardian.

---

## Task 3 — GuardianInboxScreen: history link + onDuty badge + dev button (25 min)

**File**: `client/app/src/screens/GuardianInboxScreen.tsx`

#### 3a — Destructure onDuty from hook

```typescript
const { guardianStatus, pings, loading, error, onDuty } = useGuardianPings(uid)
```

#### 3b — Add History link to nav bar

```tsx
<div className="nav-links">
  <Link to="/guardian-history" className="nav-link">History</Link>
  <Link to="/home" className="nav-link">Home</Link>
  <button ...>Sign out</button>
</div>
```

#### 3c — Update onDuty badge

Replace:
```tsx
{guardianStatus === 'verified' && (
  <span className="chip chip-green">● On duty</span>
)}
```
With:
```tsx
{guardianStatus === 'verified' && (
  onDuty
    ? <span className="chip chip-green">● On duty</span>
    : <span className="chip chip-amber">● Off duty</span>
)}
```

#### 3d — Add dev location seeding banner

Add below the error banner, above the loading skeleton:

```tsx
{import.meta.env.VITE_USE_EMULATOR === 'true' && guardianStatus === 'verified' && (
  <div className="banner banner-warning" role="note" style={{ marginBottom: '1rem' }}>
    <p className="text-sm" style={{ marginBottom: '0.5rem' }}>
      🔧 Dev: Guardian location is seeded to Bengaluru. SOS pings only appear
      if the victim's GPS is within 10km of that point.
    </p>
    <button
      className="btn btn-ghost"
      style={{ padding: '0.4rem 0.75rem', fontSize: '0.875rem', width: 'auto' }}
      onClick={() => void handleSeedLocation()}
    >
      Seed guardian at my location
    </button>
  </div>
)}
```

Add `handleSeedLocation` function in the component (requires `setDoc` and
`doc` from `firebase/firestore`, already imported via `firebase`):

```typescript
async function handleSeedLocation() {
  if (!navigator.geolocation) return
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      await setDoc(doc(db, 'guardians', uid), {
        currentLocation: {
          latitude:  pos.coords.latitude,
          longitude: pos.coords.longitude,
        },
        lastLocationUpdate: new Date(),
      }, { merge: true })
    } catch (err) {
      console.error('[GuardianInbox] Failed to seed location:', err)
    }
  })
}
```

Add `setDoc, doc` to existing `firebase/firestore` import in the screen,
and `db` from `../firebase`.

**Acceptance**: Nav bar shows "History" link. Badge shows correct duty
status. Dev banner appears only in emulator mode. "Seed guardian at my
location" updates `/guardians/{uid}` in Firestore.

---

## Task 4 — GuardianHistoryScreen (1.5 hours)

**File**: `client/app/src/screens/GuardianHistoryScreen.tsx` (new)

#### 4a — Scaffold with state machine

```typescript
type HistoryState =
  | { kind: 'loading' }
  | { kind: 'loaded'; items: HistoryItem[]; stats: GuardianStats }
  | { kind: 'error'; message: string }
```

#### 4b — Inline types and helpers

```typescript
interface HistoryItem {
  pingId:               string
  response:             'accepted' | 'declined'
  sentAt:               Date
  respondedAt:          Date
  distanceAtPingMeters: number
}

interface GuardianStats {
  totalPings:             number
  respondedCount:         number
  avgResponseTimeSeconds: number
}

function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof (value as { toDate?: unknown }).toDate === 'function')
    return (value as { toDate(): Date }).toDate()
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
```

#### 4c — Data loading on mount

```typescript
useEffect(() => {
  async function load() {
    try {
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

      const mapItem = (d: QueryDocumentSnapshot): HistoryItem | null => {
        const raw = d.data()
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
      }

      const items = [
        ...acceptedSnap.docs.map(mapItem),
        ...declinedSnap.docs.map(mapItem),
      ]
        .filter((i): i is HistoryItem => i !== null)
        .sort((a, b) => b.respondedAt.getTime() - a.respondedAt.getTime())

      const rawStats = guardianSnap.exists()
        ? guardianSnap.data()['responseStats'] as GuardianStats
        : { totalPings: 0, respondedCount: 0, avgResponseTimeSeconds: 0 }

      const stats: GuardianStats = {
        totalPings:             rawStats.totalPings             ?? 0,
        respondedCount:         rawStats.respondedCount         ?? 0,
        avgResponseTimeSeconds: rawStats.avgResponseTimeSeconds ?? 0,
      }

      setHistoryState({ kind: 'loaded', items, stats })
    } catch (err) {
      const msg = import.meta.env.VITE_USE_EMULATOR === 'true'
        ? `Failed to load history: ${(err as Error).message}`
        : 'Failed to load history. Please try again.'
      setHistoryState({ kind: 'error', message: msg })
    }
  }
  void load()
}, [uid])
```

#### 4d — Stats card rendering

```tsx
<div className="card" style={{ marginBottom: '1.5rem' }}>
  <h2 style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>My Stats</h2>
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
    <StatCell label="Total pings" value={String(stats.totalPings)} />
    <StatCell label="Responded" value={String(stats.respondedCount)} />
    <StatCell label="Response rate" value={responseRate} />
    <StatCell label="Avg response time" value={avgTime} />
  </div>
</div>
```

`StatCell` is a local inline component:
```tsx
function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', padding: '0.75rem' }}>
      <p className="text-muted text-xs" style={{ marginBottom: '0.25rem' }}>{label}</p>
      <p style={{ fontWeight: 700, fontSize: '1.1rem' }}>{value}</p>
    </div>
  )
}
```

#### 4e — History item card rendering

```tsx
{items.map(item => {
  const responseTimeSecs = Math.round(
    (item.respondedAt.getTime() - item.sentAt.getTime()) / 1000
  )
  return (
    <div key={item.pingId} className="card stack-sm">
      <div className="row-between">
        {item.response === 'accepted'
          ? <span className="chip chip-green">✓ Accepted</span>
          : <span className="chip" style={{ background: 'var(--surface-3)', color: 'var(--text-muted)' }}>✗ Declined</span>
        }
        <span className="text-muted text-xs">
          {formatResponseTime(responseTimeSecs)} response time
        </span>
      </div>
      <p className="text-muted text-sm">
        📍 {formatDistance(item.distanceAtPingMeters)} away at alert time
      </p>
      <p className="text-muted text-sm">
        {item.respondedAt.toLocaleDateString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        })}
      </p>
    </div>
  )
})}
```

**Acceptance**: Screen loads, stats card shows values from Firestore,
history items are sorted newest-first, no Firestore Timestamps in state.

---

## Task 5 — App.tsx routing (5 min)

**File**: `client/app/src/App.tsx`

1. Add import:
   ```tsx
   import { GuardianHistoryScreen } from './screens/GuardianHistoryScreen'
   ```

2. Add route inside `<RequireAuth>` block:
   ```tsx
   <Route path="/guardian-history" element={<GuardianHistoryScreen />} />
   ```

**Acceptance**: Navigating to `/guardian-history` renders the new screen.
TypeScript build passes with zero errors.

---

## Task 6 — Diagnostics + build verification (10 min)

Run diagnostics on all modified/created files:
- `client/app/src/components/PingCard.tsx`
- `client/app/src/hooks/useGuardianPings.ts`
- `client/app/src/screens/GuardianInboxScreen.tsx`
- `client/app/src/screens/GuardianHistoryScreen.tsx`
- `client/app/src/App.tsx`

Run `npm run build` in `client/app/`. Confirm `BUILD SUCCESSFUL` with
zero TypeScript errors. The chunk size warning is expected and not an error.

---

## Acceptance Checklist (mirrors requirements)

- [ ] `PingCard` "updated Xs ago" label live-updates every 10s
- [ ] Guardian Inbox nav bar has "History" link navigating to `/guardian-history`
- [ ] Guardian Inbox shows green "On duty" or amber "Off duty" badge
- [ ] Dev-only location seeding banner visible in emulator, hidden in prod
- [ ] "Seed guardian at my location" updates `/guardians/{uid}.currentLocation`
- [ ] `/guardian-history` route exists in `App.tsx`
- [ ] History screen loads responded pings via two separate `getDocs` queries
- [ ] History cards show response chip, distance, timestamp, response time
- [ ] Stats card shows totalPings, respondedCount, response rate, avg time
- [ ] Empty history state displayed when no responded pings exist
- [ ] `npm run build` passes with 0 TypeScript errors
- [ ] No Firestore Timestamp objects in any component state
- [ ] No victim UIDs/names/locations displayed in any Guardian UI

---

## Estimated Time

| Task | Est. |
|---|---|
| 1 — PingCard tick | 15 min |
| 2 — useGuardianPings onDuty | 20 min |
| 3 — GuardianInboxScreen additions | 25 min |
| 4 — GuardianHistoryScreen | 90 min |
| 5 — App.tsx routing | 5 min |
| 6 — Diagnostics + build | 10 min |
| **Total** | **~2.75 hours** |
