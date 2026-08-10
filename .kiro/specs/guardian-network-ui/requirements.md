# Requirements — Guardian Network UI

## Scope Statement

The Guardian Network UI completes the frontend for RAKSHA's third backend
pillar. The backend (onSOSSessionUpdate, respondToGuardianPing, Firestore
rules) is fully implemented and tested. This spec covers the frontend gaps
only — it does not change any backend function.

## Existing Work Inventory

Before listing requirements, here is what already exists and must NOT be
duplicated:

| Component | Status | Notes |
|---|---|---|
| `GuardianInboxScreen` | Exists, near-complete | Missing: history nav link, no `/guardian-history` route |
| `useGuardianPings` | Exists, complete for inbox | Missing: history query, `responseStats` exposure |
| `PingCard` | Exists, fully implemented | Minor gap: "updated Xs ago" label doesn't live-update |
| `LoginScreen` quickFill | Exists, seeds guardian doc | Seeds Bengaluru coords — proximity matching needs awareness |
| `App.tsx` routes | Exists | Missing: `/guardian-history` route |
| `GuardianHistoryScreen` | Does not exist | Net-new for this session |

---

## Glossary

- **Guardian**: A verified RAKSHA responder. Document at `/guardians/{uid}`.
- **GuardianPing**: A dispatch record at `/guardian_pings/{pingId}` where `pingId = ${sessionId}_${guardianId}`.
- **Pending ping**: A ping where `response == "no_response"`.
- **Responded ping**: A ping where `response == "accepted" | "declined"`.
- **responseStats**: `{ totalPings, respondedCount, avgResponseTimeSeconds }` on the Guardian document. Updated transactionally by `respondToGuardianPing`.
- **onDuty**: Boolean field on Guardian. Currently always `true`; future sessions may add a toggle.

---

## Requirements

### Requirement 1 — Guardian Inbox Screen (bring to full completion)

**User Story**: As a verified RAKSHA Guardian, I want a real-time inbox showing all active SOS pings assigned to me, so I can accept or decline and navigate to the victim.

All existing behaviour in `GuardianInboxScreen`, `useGuardianPings`, and
`PingCard` is retained. The following gaps are filled:

#### 1.1 — Live "updated X seconds ago" counter

The `PingCard` component already subscribes to `sosSessions/{sessionId}`
for live victim location and stores `lastUpdate: Date | null`. The label
`"Live · updated ${n}s ago"` is computed at render time from `Date.now() -
lastUpdate.getTime()` but there is no `setInterval` to trigger re-renders.

THE `PingCard` SHALL add a 10-second `setInterval` that calls `setState`
(or a dedicated `useReducer` tick) so the "updated Xs ago" label visibly
counts up rather than freezing at the value it had at the last render.

#### 1.2 — History navigation link

THE `GuardianInboxScreen` SHALL display a "History" link in the nav bar
(alongside the existing "Home" link) that navigates to `/guardian-history`.

#### 1.3 — Firestore listener teardown

THE `useGuardianPings` hook already returns an `unsub` cleanup function in
its `useEffect` return. No change required — this is confirmed compliant.

#### 1.4 — onDuty badge

THE `GuardianInboxScreen` SHALL show a secondary `chip-amber` badge "● Off
duty" when `guardianStatus === 'verified'` AND `onDuty === false` in the
Guardian document. The existing `chip-green` "● On duty" badge remains for
`onDuty === true`. `onDuty` is exposed by adding an `onDuty: boolean` field
to the `GuardianPingsState` interface in `useGuardianPings`.

---

### Requirement 2 — Guardian History Screen (new)

**User Story**: As a verified RAKSHA Guardian, I want to see my past ping responses and my response statistics, so I can track my contribution to the network.

#### 2.1 — Route

THE Guardian History screen SHALL be accessible at `/guardian-history`.

#### 2.2 — Responded pings query

THE screen SHALL query the Firestore `guardian_pings` collection for
documents where:
- `guardianId == uid`
- `response != "no_response"` (i.e. `response == "accepted"` OR `response == "declined"`)

Because Firestore does not support `!=` with `orderBy` on a different
field without a composite index, THE screen SHALL use TWO separate `getDocs`
queries — one for `response == "accepted"` and one for `response ==
"declined"` — and merge the results client-side, sorted by `respondedAt`
descending. This avoids requiring a new composite index.

#### 2.3 — History list display

THE screen SHALL display each responded ping as a card showing:
- Response type chip: green "✓ Accepted" or grey "✗ Declined"
- Distance at ping time: `distanceAtPingMeters` formatted as m/km (same
  `formatDistance` function as `PingCard`)
- Time responded: `respondedAt` formatted as a human-readable timestamp
  using `toLocaleDateString`/`toLocaleTimeString` — never a Firestore
  Timestamp
- Response time: seconds between `sentAt` and `respondedAt` shown as
  "Responded in Xs"

#### 2.4 — Empty history state

IF no responded pings exist, THE screen SHALL display "No responses yet.
Accepted or declined pings will appear here."

#### 2.5 — Response stats card

THE screen SHALL display the guardian's `responseStats` from
`/guardians/{uid}` in a summary card at the top:
- Total pings received: `totalPings`
- Pings responded to: `respondedCount`
- Response rate: `(respondedCount / totalPings * 100).toFixed(0)%` — shown
  as "—" if `totalPings == 0`
- Average response time: `avgResponseTimeSeconds` formatted as "Xs" or
  "Xm Ys" for times over 60s — shown as "—" if `respondedCount == 0`

#### 2.6 — Loading and error states

THE screen SHALL show a loading spinner while queries are in flight and a
`.banner.banner-error` if either query fails.

#### 2.7 — Timestamp handling

ALL timestamps read from Firestore (`sentAt`, `respondedAt`) SHALL be
deserialized using the same `toDate()` / `requireDate` pattern from
`evidenceTimestamp.ts` — adapted inline (no new import needed since the
Guardian history uses a simpler deserialization path).

---

### Requirement 3 — Dev Testing Convenience (guardian seeding)

**User Story**: As a RAKSHA developer, I want to test the full SOS → ping → accept flow without manual Firestore edits, so I can verify the Guardian Network end-to-end.

#### 3.1 — Existing quick-login confirmed correct

THE `LoginScreen` `quickFill('guardian')` already:
- Signs in or creates `guardian@test.raksha` / `password123`
- Calls `setDoc` with `verificationStatus: 'verified'`, `onDuty: true`,
  `responseStats: { totalPings: 0, respondedCount: 0, avgResponseTimeSeconds: 0 }`,
  `currentLocation: { latitude: 12.9716, longitude: 77.5946 }` (Bengaluru)
- Uses `{ merge: true }` so existing stats are NOT wiped on re-login

This is correct. No changes required.

#### 3.2 — Known limitation: hardcoded location

THE guardian's seeded location is hardcoded to Bengaluru (12.9716°N,
77.5946°E). THE victim's SOS trigger captures real GPS via
`getCurrentHashedLocation()`. IF the test device's real GPS position differs
significantly from Bengaluru, `onSOSSessionUpdate`'s proximity filter
(1km → 10km rings) WILL NOT match the guardian.

**Mitigation for dev testing**: THE `GuardianInboxScreen` SHALL display a
dev-only banner (visible when `VITE_USE_EMULATOR === 'true'`) explaining
this limitation and showing a button "Seed guardian at my location" that
calls `navigator.geolocation.getCurrentPosition` and `setDoc`-merges the
real coordinates into `/guardians/{uid}`. This button is hidden in
production.

#### 3.3 — End-to-end test procedure (documented, not coded)

The full test procedure for emulator testing:
1. Browser A (victim): log in as `victim@test.raksha`, configure Shake
   trigger, shake to trigger SOS
2. Browser B (guardian): log in as `guardian@test.raksha`, click "Seed
   guardian at my location" (if in emulator), navigate to Guardian Inbox
3. Wait up to 30s for `onSOSSessionUpdate` to run after SOS goes active
4. Browser B should show a PingCard; tap "Accept"
5. Browser A's `sosSessions/{id}` document should show `guardiansPinged`
   array containing the guardian's UID

---

### Requirement 4 — Design Language Consistency

THE Guardian History screen SHALL use the same design tokens as all other
screens: `.screen`, `.card`, `.stack`, `.chip`, `.banner`, `.nav-bar`,
`.btn`, `.btn-ghost`, `.text-muted`, `.spinner`, etc.

ALL timestamps in state SHALL be native `Date` objects. Firestore
`Timestamp` objects SHALL be converted at the deserialization boundary.

ALL Firestore listeners and queries SHALL use the `db` instance from
`firebase.ts` (emulator-aware by default when `VITE_USE_EMULATOR=true`).

---

### Requirement 5 — Privacy

THE Guardian History screen SHALL NOT display any victim information (name,
UID, precise location). Only the guardian's own `distanceAtPingMeters` at
ping time and their response behaviour is shown. This mirrors the privacy
constraint already in `PingCard` (which shows distance and elapsed time
but no identifying victim details).

---

## Out of Scope

1. **onDuty toggle UI**: Guardians cannot toggle their own `onDuty` status
   in this session. The field exists on the document but no switch is added.
2. **Guardian profile / verification flow**: No UI for submitting
   verification documents or viewing status. Out of scope.
3. **Victim-side guardian response display**: The victim's `CountdownScreen`
   does not show which guardians accepted. Deferred.
4. **Push notifications**: Guardians are not notified via FCM in this
   session. The ping appears only when the Inbox is open.
5. **Pagination**: The history list is unbounded — no pagination in this
   session. Acceptable for a personal history (typically low volume).

---

## Acceptance Checklist

- [ ] `PingCard` "updated Xs ago" label live-updates every 10s
- [ ] Guardian Inbox nav bar has "History" link
- [ ] Guardian Inbox shows correct onDuty badge (green/amber)
- [ ] `/guardian-history` route exists in `App.tsx`
- [ ] History screen loads responded pings from two separate queries
- [ ] History cards show response type, distance, respondedAt, response time
- [ ] History screen shows `responseStats` summary card
- [ ] Empty history state displayed when no responded pings
- [ ] Dev-only "Seed guardian at my location" button visible in emulator
- [ ] No Firestore Timestamp objects in any component state
- [ ] All Firestore listeners torn down on unmount
- [ ] No victim UIDs or names displayed anywhere in Guardian UI
