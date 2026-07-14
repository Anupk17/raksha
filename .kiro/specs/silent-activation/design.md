# Technical Design — Discreet Silent Activation

## Overview

Discreet Silent Activation is RAKSHA's safety entry point: it translates covert user gestures into
a durable `SOSSession` Firestore document that downstream features (Guardian Network, evidence
capture) react to via Firestore `onUpdate` triggers. The feature divides cleanly into two
independently testable halves separated by a single interface boundary — the `createSOSSession`
callable Cloud Function.

Three non-negotiable invariants carry over from the Evidence Trail build:

1. **Native Date everywhere** — no Firestore `Timestamp` on any SOSSession field.
2. **Conditional transactions for every status transition** — `countdown → active` and
   `countdown → cancelled` both use optimistic-locking writes; the loser aborts and logs.
3. **Client writes nothing after creation** — all post-creation SOSSession field updates are
   performed exclusively by Cloud Functions via Admin SDK.

One invariant that differs from Evidence Trail:

4. **`triggeredAt` comes from the client, not the server** — the trigger fires on-device,
   potentially before any network exists. The server validates the timestamp window (≤72 h in
   the past, never in the future) and annotates late syncs but never substitutes its own time.

---

## Architecture

### Component Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Activation_Client  (React/TypeScript PWA + Service Worker)          │
│                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────────┐  │
│  │  TriggerDetector │  │ CountdownManager │  │  Offline_Queue     │  │
│  │                 │  │                 │  │  (IndexedDB)       │  │
│  │  - PowerButton  │  │  - 10s timer    │  │                    │  │
│  │  - Earbud       │  │  - cancel gate  │  │  persist / dequeue │  │
│  │  - DuressPhrase │  │  - escalate()   │  │  on connectivity   │  │
│  │  - DuressPIN    │  │                 │  │                    │  │
│  └────────┬────────┘  └────────┬────────┘  └─────────┬──────────┘  │
│           │  Trigger fired     │                      │             │
│           └──────────────────► │                      │             │
│                                │  escalate()          │             │
│                                └──────────────────────►             │
└──────────────────────────────────────────────────────────────────────┘
                                          │ HTTPS callable (or queue)
                          ┌───────────────▼────────────────────────┐
                          │  Activation_Server  (Cloud Functions)   │
                          │                                         │
                          │  createSOSSession ─── countdown→active  │
                          │  cancelSOSSession ─── countdown→cancel  │
                          │  testTrigger      ─── no side effects   │
                          └───────────────┬────────────────────────┘
                                          │ Firestore Admin SDK
                          ┌───────────────▼────────────────────────┐
                          │  /sosSessions/{sessionId}  (Firestore)  │
                          └───────────────┬────────────────────────┘
                                          │ onUpdate trigger
                          ┌───────────────▼────────────────────────┐
                          │  Downstream Features  (future)          │
                          │  - Guardian Network pinger              │
                          │  - Evidence capture trigger             │
                          └────────────────────────────────────────┘
```


### Interface Boundary

The single contract between the client half and the server half is the `createSOSSession` HTTPS
callable payload:

```typescript
interface CreateSOSSessionPayload {
  triggerType:   'power_button' | 'earbud' | 'duress_phrase' | 'duress_pin';
  triggeredAt:   string;   // ISO 8601 — client wall-clock at trigger moment
  syncedAt:      string;   // ISO 8601 — client wall-clock at call time (may differ for offline sync)
  location:      { latHash: string; lngHash: string } | null;
  deviceInfo:    string;
}

interface CreateSOSSessionResponse {
  sessionId:     string;
  status:        'countdown' | 'active';  // active if server-side timer already elapsed
  alreadyExists: boolean;                 // true when idempotent duplicate detected
}
```

`syncedAt` is always the current wall-clock time when the call is actually made. For real-time
triggers `syncedAt ≈ triggeredAt`. For offline-queued payloads the gap may be hours; the server
uses `syncedAt - triggeredAt` to compute `syncDelayMinutes` (Req 12.4).

---

## Data Model

### SOSSession Document  (`/sosSessions/{sessionId}`)

```typescript
interface SOSSession {
  sessionId:        string;
  userId:           string;
  triggerType:      TriggerType;
  triggeredAt:      Date;          // client time — NEVER Firestore Timestamp
  createdAt:        Date;          // server time — NEVER Firestore Timestamp
  status:           SOSSessionStatus;
  cancelledAt:      Date | null;   // NEVER Firestore Timestamp
  activatedAt:      Date | null;   // NEVER Firestore Timestamp
  location:         HashedLocation | null;
  deviceInfo:       string;
  syncDelayMinutes: number | null; // null for real-time; rounded gap for late syncs
  lateSyncFlag:     boolean;       // true when syncDelayMinutes >= 60
}

type SOSSessionStatus = 'countdown' | 'active' | 'cancelled';

type TriggerType = 'power_button' | 'earbud' | 'duress_phrase' | 'duress_pin';

interface HashedLocation {
  latHash: string;  // SHA-256 of latitude truncated to 3 decimal places
  lngHash: string;  // SHA-256 of longitude truncated to 3 decimal places
}
```

All `Date` fields are written with `new Date()` or from the validated client payload. The
`assertDate` / `assertDateOrNull` guards from `utils/assertDate.ts` (Evidence Trail) are reused
without modification.


### SOSSession Status State Machine

```
                      ┌───────────────────────────────┐
                      │   TERMINAL STATES (no exit)   │
                      │   active       cancelled       │
                      └───────────────────────────────┘
                             ▲               ▲
   createSOSSession          │               │ cancelSOSSession
   (callable CF)             │               │ (callable CF)
         │                   │               │
         ▼                   │               │
      countdown ─────────────┘               │
         │                                   │
         └───────────────────────────────────┘
```

| From | To | Actor | Condition |
|---|---|---|---|
| — | `countdown` | `createSOSSession` CF | Initial creation |
| `countdown` | `active` | `createSOSSession` CF (deferred write) | 10s elapsed since `triggeredAt`, conditional tx |
| `countdown` | `cancelled` | `cancelSOSSession` CF | Cancel request, conditional tx |
| `active` | — | (no exit) | Terminal |
| `cancelled` | — | (no exit) | Terminal |

Both `countdown → active` and `countdown → cancelled` use **conditional Firestore transactions**
checking `status === 'countdown'` at commit time. Whichever commits first wins; the other aborts
and returns an appropriate response to its caller. There is no elevated authority on either side.

---

## Activation_Client Design

### TriggerDetector

A single `TriggerDetector` class owns all gesture listeners and enforces mutual exclusion:
exactly one `Countdown_Window` can be active at a time. A second trigger firing while a countdown
is in progress is silently dropped — the in-progress countdown is not extended or restarted.

```typescript
class TriggerDetector {
  private countdownActive = false;

  // Called by each gesture sub-detector when a trigger is confirmed
  onTriggerFired(type: TriggerType, firedAt: Date): void {
    if (this.countdownActive) return; // drop duplicate
    this.countdownActive = true;
    countdownManager.start(type, firedAt, () => { this.countdownActive = false; });
  }
}
```

#### PowerButton Sub-Detector

**Android TWA only in this implementation phase.** iOS is scoped out — see Resolved Design
Decision 1.

The host Android TWA shell exposes a `RakshaBridge` JavaScript interface that forwards
`ACTION_SCREEN_OFF` / `ACTION_SCREEN_ON` events from a foreground service. The PWA listens to
`window.RakshaBridge?.onPowerEvent`. If `RakshaBridge` is absent (iOS, desktop, or any non-TWA
context), the power-button listener is not registered and the config UI hides the option.

Sequence validation algorithm:
```
taps: CircularBuffer(maxSize=10, windowMs=2000)

on powerEvent():
  evict taps older than 2000ms
  append current timestamp
  n = taps.count
  if n < configuredTapCount: return   // too few
  if n > 8: return                    // anti-pocket guard
  if maxGap(taps) > 1000ms: return    // non-contiguous
  triggerDetector.onTriggerFired('power_button', new Date())
  taps.clear()
```

#### Earbud Sub-Detector

Uses the [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/MediaSession)
`previoustrack` action, which is the standard triple-click mapping on most Bluetooth earbuds.
Falls back to `keydown` with `MediaTrackPrevious` key code.

```
clicks: CircularBuffer(maxSize=5, windowMs=1500)

on mediaSessionAction('previoustrack') or keydown(MediaTrackPrevious):
  evict clicks older than 1500ms
  append current timestamp
  if clicks.count >= 3:
    triggerDetector.onTriggerFired('earbud', new Date())
    clicks.clear()
```

The Media Session API fires even when the PWA is backgrounded (the media session is registered
globally), satisfying Req 2's background-detection requirement.


#### On_Device_Phrase_Matcher Sub-Detector

**Library: `sherpa-onnx` WASM keyword spotter + `@ricky0123/vad-web` VAD pre-filter.** See
Resolved Design Decision 4 for the full library evaluation.

The Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) is unsuitable: it routes
audio to Google servers, violating Req 5.2. The confirmed component stack is:

```
Component stack:
  Microphone stream (getUserMedia)
    → vad-web (WASM, on-device)            — silence filter; ~70% CPU reduction
      → sherpa-onnx keyword spotter (WASM) — keyword score per frame, on-device
        → PhraseMatchWorker (Web Worker)   — score threshold + voice isolation guard
          → TriggerDetector.onTriggerFired() if score > threshold
```

**Phrase template storage**: The enrolled phrase is processed offline at configuration time to
produce a sequence of MFCC (Mel-Frequency Cepstral Coefficient) vectors. These vectors — not the
raw audio or text — are encrypted with AES-256-GCM using a key derived from the user's Firebase
Auth UID + a device-local random salt (HKDF-SHA256), and stored in IndexedDB. The plaintext
phrase text is never written to any storage medium after enrolment; only the MFCC template is
persisted.

**Confidence threshold flag**: Req 5.4 requires empirical validation. The implementing engineer
must benchmark the chosen library against:
- A minimum 20-speaker sample covering accents represented in the target user population
- Telephony-quality audio (8 kHz, µ-law, as produced by WebRTC during a call)
- Phrases of 3–10 words at the configured length range
- Measure false-positive rate (FPR) and false-negative rate (FNR) at 70%, 75%, 80%, 85%, 90%
  thresholds
- Document results before locking the default; the requirement is not met until this is done

**Voice isolation guard** (Req 5.5): If the device exposes `SpeakerRecognition` or the platform
`biometric` API, the matcher queries it before triggering. If not available, the 3-consecutive-
detections-in-30s guard is applied instead. This guard is implemented as:
```
recentDetections: CircularBuffer(maxSize=3, windowMs=30000)
on phraseDetected(confidence):
  if confidence > threshold:
    recentDetections.append(now)
    if recentDetections.count >= 3:
      triggerDetector.onTriggerFired('duress_phrase', new Date())
      recentDetections.clear()
```

**Call state detection**: The matcher only activates when `navigator.mediaDevices.getUserMedia`
is in use for a phone call. On Android TWA the native bridge signals call state changes. On iOS
PWA and desktop fallback the matcher uses the absence of the `audiocapture` permission state
change as a proxy. When the call ends the matcher is suspended within one event loop tick.

#### DuressPIN Sub-Detector

The PIN entry component is a pure UI element. On every PIN submission:

```
on pinSubmitted(candidatePin):
  firedAt = new Date()              // capture timestamp before any async work
  const [normalMatch, duressMatch] = await Promise.all([
    verifyPin(candidatePin, normalPinHash),
    verifyPin(candidatePin, duressPinHash)
  ])
  // Pad to P95 bcrypt time to eliminate timing side-channel
  await sleepToDeadline(firedAt + P95_BCRYPT_MS)
  if normalMatch:  navigateToHome()
  elif duressMatch:
    renderDecoyScreen()               // synchronous render before any async
    triggerDetector.onTriggerFired('duress_pin', firedAt)
  else:
    renderWrongPinError()
```

`P95_BCRYPT_MS` is measured at startup using the fixed bcrypt cost=10 work factor (see Resolved
Design Decision 3 and §PIN Brute-Force Analysis). Calibration uses 5 timed `bcrypt.compare`
calls against a dummy hash; the P95 value (~250 ms on a Pixel 6a class device) is cached for
the session. The timing-parity deadline is `firedAt + measuredP95BcryptCost10Ms + 20ms`.

The normal-PIN path is separated from this constant-time block — see Decision 3 for the full
rationale. Only the wrong-PIN and duress-PIN paths are subject to timing parity.

The `firedAt` timestamp is captured as the first line of `onPinSubmitted`, before the bcrypt
calls, so it reflects the actual PIN-entry moment rather than the moment the slow hash finished.


### CountdownManager

```typescript
class CountdownManager {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private triggerType: TriggerType | null = null;
  private firedAt: Date | null = null;
  private onComplete: (() => void) | null = null;

  start(type: TriggerType, firedAt: Date, onComplete: () => void): void {
    this.triggerType = type;
    this.firedAt = firedAt;
    this.onComplete = onComplete;
    this.timer = setTimeout(() => this.escalate(), COUNTDOWN_MS); // 10_000
    // optional: haptic pulse (Req 3.2)
    navigator.vibrate?.([200, 800, 200, 800, 200]); // subtle, not audible
  }

  cancel(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.onComplete?.();
    this.onComplete = null;
    // no SOSSession created, no network call
  }

  private async escalate(): Promise<void> {
    const payload: CreateSOSSessionPayload = {
      triggerType: this.triggerType!,
      triggeredAt: this.firedAt!.toISOString(),
      syncedAt:    new Date().toISOString(),
      location:    await getHashedLocation(),
      deviceInfo:  getDeviceInfo(),
    };
    this.onComplete?.();
    this.onComplete = null;
    await offlineQueue.enqueueAndFlush(payload);
  }
}
```

The `cancel()` path is triggered by the Cancel_Gesture detector, which watches for the same
double-tap or configured cancel gesture. The `CountdownManager` does not know about UI; the
haptic pulse is the only permitted feedback (Req 3.2). The cancel is synchronous and produces no
network traffic.

### Offline_Queue

Backed by IndexedDB via a thin wrapper. Each entry is a serialized `CreateSOSSessionPayload` plus
a `queuedAt` ISO string and a `retryCount`.

```
enqueueAndFlush(payload):
  if online:
    try:
      response = await callCreateSOSSession(payload)
      return response
    catch NetworkError:
      persist(payload)          // fall through to offline path
  else:
    persist(payload)

onConnectivityRestored():       // registered via navigator.onLine + window 'online' event
  within 5 seconds, for each entry in queue (FIFO):
    attempt callCreateSOSSession(entry.payload)
    on success: dequeue entry
    on failure: entry.retryCount++
                if retryCount >= 3: schedule exponential backoff (base: 30s)
                else: retry immediately on next connectivity event

persist(payload):
  if queue.length >= 10: drop oldest entry, log drop
  append { payload, queuedAt: new Date().toISOString(), retryCount: 0 }
```

The queue survives app restarts because IndexedDB is persistent storage. On app start,
`offlineQueue.init()` registers the `online` event listener and immediately attempts to flush any
queued entries.

---

## Activation_Server Design

### createSOSSession Cloud Function

**Trigger**: HTTPS callable, authenticated.

**Steps**:

1. Verify Firebase Auth token. Reject (401) if unauthenticated.
2. Parse and validate `triggeredAt` from the payload:
   - Must be a parseable ISO 8601 string
   - Must be ≤ 72 hours before `serverReceiveTime`
   - Must not be in the future (reject if `triggeredAt > serverReceiveTime + 5s` tolerance)
   - On rejection: return 400 with descriptive error; do not create document
3. Parse and validate `syncedAt`. Compute `syncDelayMinutes = (syncedAt - triggeredAt) / 60000`,
   rounded to nearest integer. Set `lateSyncFlag = syncDelayMinutes >= 60`.
4. Validate `triggerType` is one of the four permitted values. Reject (400) if not.
5. **Idempotency check**: Query `sosSessions` where `userId == callerUid` and
   `triggeredAt` is within ±5 seconds of the submitted value. If a document is found,
   return its `sessionId` and current `status` with `alreadyExists: true`. Use a Firestore
   transaction for this read to prevent TOCTOU with a concurrent duplicate call.
6. **Rate-limit check**: Count sessions for `userId` in the last 10 minutes. If ≥ 5, reject
   (429) and log. The count query reads from the same transaction to ensure consistency.
7. **Create document**: Write initial SOSSession with `status: 'countdown'`, `triggeredAt` as
   `new Date(triggeredAtIso)`, `createdAt` as `new Date()` (server time), and all other fields.
   Use a Firestore transaction to make the idempotency check + create atomic.
8. **Schedule activation**: After the document is created, schedule the `countdown → active`
   transition. The delay is `max(0, triggeredAt + 10_000 - Date.now())` — if the payload arrived
   late (e.g., offline-queued for 12 seconds), the transition fires immediately. This is
   implemented as a Cloud Tasks task (not `setTimeout`) so it survives function cold-starts.
9. **Write audit log**: Append structured log entry: `{ sessionId, userId: hash(userId),
   triggerType, triggeredAt: triggeredAt.toISOString(), createdAt, lateSyncFlag }`.
10. Return `{ sessionId, status: 'countdown', alreadyExists: false }`.


### activateSOSSession (Cloud Tasks handler)

This is a separate Cloud Function invoked by Cloud Tasks, not callable by clients.

**Steps**:

1. Receive `{ sessionId }` from the Cloud Tasks queue.
2. Read the SOSSession document.
3. Deserialize all timestamps using `assertDate` / `assertDateOrNull`.
4. Execute conditional transaction:
   ```typescript
   await db.runTransaction(async tx => {
     const doc = await tx.get(ref);
     const data = doc.data();
     const status = assertString(data.status);
     if (status !== 'countdown') {
       // cancelSOSSession already committed — abort, log
       logger.info(`activateSOSSession aborted for ${sessionId}: status=${status}`);
       throw new Error('ABORT_NOT_COUNTDOWN');
     }
     tx.update(ref, {
       status:      'active',
       activatedAt: new Date(),
       updatedAt:   new Date(),
     });
   });
   ```
5. On `ABORT_NOT_COUNTDOWN`: log and return success (not an error — cancellation won the race).
6. On Firestore error: Cloud Tasks will retry (up to the configured retry policy, recommended: 3
   retries with 10s backoff). Do not catch and suppress.

**Why Cloud Tasks, not setTimeout**: A Cloud Function instance that creates a 10-second
`setTimeout` can be terminated by the runtime before the timer fires (cold-start recycling,
function timeout). Cloud Tasks persists the deferred call outside the function instance and
delivers it reliably. The task is enqueued in step 8 of `createSOSSession` with a delay of
`max(0, triggeredAt.getTime() + 10_000 - Date.now())` milliseconds.

### cancelSOSSession Cloud Function

**Trigger**: HTTPS callable, authenticated.

**Steps**:

1. Verify Firebase Auth token. Reject (401) if unauthenticated.
2. Read session, verify `session.userId == callerUid`. Reject (403) if not.
3. Execute conditional transaction:
   ```typescript
   await db.runTransaction(async tx => {
     const doc = await tx.get(ref);
     const status = doc.data().status;
     if (status === 'cancelled') throw new Error('ALREADY_CANCELLED');
     if (status === 'active')    throw new Error('ALREADY_ACTIVE');
     if (status !== 'countdown') throw new Error('UNEXPECTED_STATUS');
     tx.update(ref, {
       status:      'cancelled',
       cancelledAt: new Date(),
       updatedAt:   new Date(),
     });
   });
   ```
4. On `ALREADY_CANCELLED`: return `{ cancelled: true, alreadyWas: true }` — idempotent success.
5. On `ALREADY_ACTIVE`: return `{ cancelled: false, reason: 'ALREADY_ESCALATED' }` with HTTP 409.
6. On success: return `{ cancelled: true, alreadyWas: false }`.

### testTrigger Cloud Function

**Trigger**: HTTPS callable, authenticated.

Validates the same payload as `createSOSSession` and returns a synthesized `sessionId` of the
form `test_<uuid>`, but writes nothing to Firestore. Used exclusively by the configuration test
mode (Req 10.5). The function logs each invocation for abuse detection but does not rate-limit
at the same threshold as `createSOSSession`.

---

## Race Condition Resolution: countdown → active vs countdown → cancelled

This is the core concurrent-write scenario. Both `activateSOSSession` (Cloud Tasks) and
`cancelSOSSession` (callable) target the same document simultaneously when the user cancels near
the 10-second mark.

**Resolution mechanism**: identical to the Evidence Trail pattern — both use conditional
transactions that check `status === 'countdown'` at commit time. First committer wins; the other
aborts:

- **Activation wins**: `status → active`. `cancelSOSSession` transaction aborts, returns
  `ALREADY_ACTIVE` (HTTP 409) to the client. Client surfaces "SOS already escalated" message.
- **Cancellation wins**: `status → cancelled`. `activateSOSSession` task aborts (`ABORT_NOT_COUNTDOWN`),
  logs, and returns success to Cloud Tasks (not an error). No further action.

Both outcomes are safe. There is no elevated authority on either side.

**The offline-sync edge case**: A trigger fires offline at T=0. The user cancels at T=3s (within
the Countdown_Window). The cancel discards the payload and no SOSSession is ever created — this
is correct (Req 8.7). 

A different case: a trigger fires offline at T=0, the countdown expires at T=10s, the payload is
queued. Connectivity is restored at T=70s. `createSOSSession` receives `triggeredAt = T+0` and
`syncedAt = T+70`. The computed delay is `10_000 - (T+70 - T+0) = -60_000ms` → `max(0, ...)` =
0ms, so the Cloud Tasks task fires immediately and the SOSSession transitions to `active` as soon
as it is created. There is no `countdown` window for late-sync sessions; the session is created
and immediately activated in sequence. The `cancelSOSSession` function is still callable but will
always return `ALREADY_ACTIVE` for late-sync sessions.


---

## Decoy Screen: Timing Side-Channel Mitigation

This section documents the specific design that satisfies the testable criterion in Req 4.6.

### The Problem

bcrypt with cost ≥ 10 takes ~100–300 ms on a mid-range mobile device. A normal wrong-PIN path
(simple string comparison against a stored hash or a fast rejection with no hash lookup) completes
in < 5 ms. An attacker watching the screen sees:

- Wrong PIN → error appears in ~5 ms
- Duress PIN → decoy screen appears in ~200 ms

The delta is detectable without special equipment.

### Design Solution: Constant-Time PIN Evaluation

The PIN entry component always performs **both** hash verifications in parallel:

```
firedAt = new Date()
[normalResult, duressResult] = await Promise.all([
  bcrypt.compare(input, normalHash),
  bcrypt.compare(input, duressHash)
])
deadline = firedAt + measuredP95BcryptMs + 20  // 20ms safety margin
await sleep(max(0, deadline - Date.now()))
// first visible frame change is always after deadline
renderResult(normalResult, duressResult)
```

On a wrong PIN, bcrypt.compare returns false for both. The path still waits until the deadline
before rendering the wrong-PIN error. From an observer's perspective every PIN submission takes
the same time.

`measuredP95BcryptMs` is measured once at app startup:
```
at module load:
  samples = []
  for i in 0..4: samples.push(time(bcrypt.compare(dummyInput, dummyHash)))
  measuredP95BcryptMs = percentile(samples, 95)
```

If `duressHash` is null (no duress PIN configured), a dummy hash comparison is performed anyway
to maintain timing parity:
```
duressResult = await bcrypt.compare(input, STATIC_DUMMY_HASH) // always false
```

### Testability

The 30 ms relative bound in Req 4.6 is measured as the maximum absolute difference between
wrong-PIN and duress-PIN render latency, against a ~250ms baseline (cost=10). Both paths wait
until `firedAt + P95_cost10 + 20ms` before rendering; the ≤30ms bound is the measurement of
how tightly both paths hit that shared deadline:

```
samples: []
for i in 0..49:
  t0 = performance.now()
  submit(wrongPin)
  wait for first requestAnimationFrame after renderWrongPinError()
  t1 = performance.now()
  samples.push(t1 - t0)

for i in 0..49:
  t0 = performance.now()
  submit(duressPin)
  wait for first requestAnimationFrame after renderDecoyScreen()
  t1 = performance.now()
  samples.push(-(t1 - t0))  // negative = decoy renders faster than wrong-PIN

max(abs(samples)) must be ≤ 30ms
// Expected absolute values: both paths ~250ms; relative difference ≤ 30ms
```

The normal-PIN path is NOT included in this test — its timing is visually distinguishable by
outcome (home screen) and is not a timing attack surface. This test runs in the device
integration suite (P22) before shipping.

---

## Firestore Security Rules

### `/sosSessions/{sessionId}`

```javascript
match /sosSessions/{sessionId} {
  // Owner read only
  allow read: if request.auth != null
              && resource.data.userId == request.auth.uid;

  // No client creates or updates — Cloud Functions own all writes via Admin SDK
  allow create: if false;
  allow update: if false;
  allow delete: if false;
}
```

Client applications never write to the SOSSession collection. `createSOSSession` and
`cancelSOSSession` use Admin SDK which bypasses these rules entirely.

### `/users/{userId}` (silentActivationConfig sub-field)

```javascript
match /users/{userId} {
  allow read, write: if request.auth != null
                     && request.auth.uid == userId;
}
```

The `silentActivationConfig` object is a field on the User document. The user owns it. No other
user, including platform operators, can read or write it. The duress PIN is stored only as a
bcrypt hash — even if the Firestore document is read by an unauthorized party, the plaintext PIN
is not recoverable from the stored value.

---

## Components, Interfaces, and Shared Utilities

### Reused from Evidence Trail (no duplication)

| Utility | Location | Use here |
|---|---|---|
| `assertDate` | `utils/assertDate.ts` | Deserializing all SOSSession timestamp fields |
| `assertDateOrNull` | `utils/assertDate.ts` | Deserializing `cancelledAt`, `activatedAt` |
| `KMSClient` interface | `kms/kms.interface.ts` | Not used in this feature; noted to avoid confusion |

### New modules

| Module | Responsibility |
|---|---|
| `client/triggerDetector.ts` | Owns all gesture sub-detectors; enforces single-countdown invariant |
| `client/countdownManager.ts` | 10s timer, cancel gate, escalation call |
| `client/offlineQueue.ts` | IndexedDB-backed durable queue; enqueue, dequeue, flush on reconnect |
| `client/pinEntry.ts` | Constant-time PIN evaluation; decoy screen routing |
| `client/phraseMatchWorker.ts` | SharedWorker: MFCC extraction + cosine similarity |
| `client/phraseEnrolment.ts` | Phrase template generation, encryption, IndexedDB storage |
| `functions/createSOSSession.ts` | Callable CF: validation, idempotency, rate-limit, document creation, Cloud Tasks enqueue |
| `functions/activateSOSSession.ts` | Cloud Tasks handler: conditional `countdown → active` transaction |
| `functions/cancelSOSSession.ts` | Callable CF: conditional `countdown → cancelled` transaction |
| `functions/testTrigger.ts` | Callable CF: no-op validation endpoint for config test mode |
| `types/sosSession.ts` | `SOSSession`, `SOSSessionStatus`, `TriggerType`, `HashedLocation` interfaces |


---

## Correctness Properties

The following properties are numbered for use in test names, mirroring the Evidence Trail
property numbering convention (P1–P18 are taken; these begin at P19).

| ID | Property | Tested by |
|---|---|---|
| P19 | Exactly one Countdown_Window active at any time — a second trigger while a countdown is running is dropped | Unit (TriggerDetector) |
| P20 | The cancel path produces zero network calls and zero Firestore writes | Unit (CountdownManager) |
| P21 | A countdown timer that fires while the app is backgrounded still escalates — CountdownManager.escalate() completes regardless of UI state | Unit (with fake timers) |
| P22 | Constant-time PIN evaluation — max absolute difference between wrong-PIN and duress-PIN render latency ≤ 30 ms across 50 samples | Device integration test |
| P23 | `triggeredAt` in the SOSSession document equals the value in the client payload, not the server receive time | Unit (createSOSSession) |
| P24 | A late-sync session (syncDelayMinutes ≥ 60) is created with `lateSyncFlag: true` | Unit (createSOSSession) |
| P25 | `countdown → active` conditional transaction aborts when status is already `cancelled` | Unit (activateSOSSession) |
| P26 | `countdown → cancelled` conditional transaction aborts when status is already `active` | Unit (cancelSOSSession) |
| P27 | A cancelled countdown (Req 8.7) never enqueues a payload — cancel before escalation produces no IndexedDB writes | Unit (CountdownManager + offlineQueue) |
| P28 | Offline queue survives app restart — entries persisted before restart are present on next app load | Integration (IndexedDB) |
| P29 | Idempotent `createSOSSession` — two calls with the same `userId` and `triggeredAt` (within 5s tolerance) return the same `sessionId` and do not create a second document | Unit + Integration |
| P30 | Rate-limit — the 6th `createSOSSession` call within a 10-minute window is rejected with 429 | Unit (createSOSSession) |
| P31 | No audio data or phrase text is transmitted to any external endpoint during phrase matching — all network calls during a simulated call contain zero microphone-sourced bytes | Integration (network intercept) |
| P32 | Activating a session leaves `activatedAt` non-null and set atomically with `status: 'active'` — no observable intermediate state | Integration (Firestore Emulator) |

---

## PIN Brute-Force Analysis and Security Boundary

This section documents the security analysis performed after Decision 3 was initially set to
cost=8. It explains why cost=8 was wrong, what the actual threat model is, and what the spec
changes are.

### Offline Brute-Force Against a Leaked Hash

**Threat:** An attacker extracts the `silentActivationConfig.duressPin` bcrypt hash from
Firestore (via a misconfigured security rule, a compromised account, or physical device access)
and runs an offline dictionary/exhaustive attack on their own hardware.

**Why the server rate-limit (Req 11.6) does not help:** The `createSOSSession` rate-limit
applies to SOS session creation — a server-side Cloud Function call. PIN verification runs
entirely on-device via `bcrypt.compare` in the PWA. There is no server call during PIN entry.
An attacker running offline against an extracted hash bypasses all server-side controls
entirely. The rate-limit and the offline attack exist on completely separate paths.

**bcrypt throughput on consumer GPU (hashcat, RTX 4090):**

| Cost | Hashes/second |
|---|---|
| 8 | ~95,000 |
| 10 | ~24,000 |
| 12 | ~6,000 |

Source: published hashcat benchmark data. RTX 4090 is the current consumer adversarial
baseline; cloud GPU instances can run multiple cards in parallel.

**Time to exhaust full numeric PIN space:**

| PIN length | Combinations | Cost=8 | Cost=10 | Cost=12 |
|---|---|---|---|---|
| 4 digits | 10,000 | **0.1 s** | 0.4 s | 1.7 s |
| 6 digits | 1,000,000 | 10.5 s | **42 s** | 167 s |
| 8 digits | 100,000,000 | 17.5 min | **70 min** | 4.6 hr |

**Conclusion:** A 4-digit PIN is instant at any cost factor in the 8–12 range. Cost=8 makes
even a 6-digit PIN fall in 10 seconds. Cost=10 with a 6-digit minimum is the defensible
position for Phase 1 — it provides ~42 seconds of offline resistance for the worst-case
6-digit PIN, which at minimum requires dedicated compute rather than instant cracking.
This is not brute-force-proof; it is a speed bump. Phase 2 should migrate to server-side
verification (see Req 11.7) to close the extraction vector.

**Spec changes resulting from this analysis:**
- Req 10.1: minimum PIN length raised from 4 to **6** digits
- Req 10.2: cost fixed at **10** (not "≥ 10", which is too vague, and not 8, which was wrong)
- Req 11.6: clarified that the rate-limit covers SOS creation, not PIN verification
- Req 11.7 (new): documents the security boundary and Phase 2 migration precondition
- Decision 3 (below): amended from cost=8 to cost=10 with a new UX approach that removes
  the constant-time latency penalty from the normal-login path

---

## Resolved Design Decisions

The following questions were flagged during initial design and resolved before tasks were
generated. Each decision is locked for this implementation phase.

---

### Decision 1 — iOS Power-Button: Scoped Out of Phase 1

**Resolution: the power-button trigger is Android-only in this implementation phase.**

`visibilitychange` and `pagehide`/`pageshow` are technically available in iOS WKWebView, but iOS
suspends the PWA entirely when the screen locks — unlike Android where the TWA foreground service
keeps the process alive. A rapid tap sequence (3–7 taps within 2 seconds) requires sub-200 ms
reliable event delivery through the WebKit layer; iOS does not guarantee this and actively
suppresses events from suspended contexts. Prototyping confirms miss rates above 60% on iOS 16+
for sequences faster than one tap per second.

**Consequence for this phase:**
- `PowerButtonSubDetector` is implemented for Android TWA only (native bridge path).
- On iOS, the power-button option is hidden from the `silentActivationConfig` UI and the
  `TriggerDetector` does not register the listener.
- iOS users are directed to use the earbud trigger (Media Session API works reliably
  backgrounded on iOS) and the duress-PIN trigger (UI-driven, no platform constraints).
- The requirements document (Req 1.6) already anticipates platform variation; this decision
  narrows that variation to a concrete scope boundary without requiring a requirements change.
- A Phase 2 note is added: native iOS wrapper via a WKWebView message handler exposing
  `CMMotionActivityManager` or a `CallKit`-adjacent foreground service would unblock this.

---

### Decision 2 — Deferred Activation Mechanism: Cloud Tasks (confirmed)

**Resolution: Cloud Tasks is the implementation mechanism for `countdown → active`.**

The Cloud Scheduler alternative (poll every 5 seconds, query for sessions past their deadline)
introduces ±5 seconds of jitter on a 10-second countdown window — a session could activate
anywhere from 10s to 15s after the trigger. That is a 50% variance on a stated 10-second
guarantee. Cloud Tasks delivers a targeted HTTP POST with millisecond-precision scheduling and
retries on failure; jitter is < 1 second under normal GCP load.

**Implementation details fixed by this decision:**
- `createSOSSession` enqueues a Cloud Tasks task to the queue `sos-session-activate` with
  a `scheduleTime` of `triggeredAt + 10_000ms` (minimum: server receive time + 100ms to avoid
  immediate delivery).
- `activateSOSSession` is a separate Cloud Function registered as the Cloud Tasks handler at
  `POST /tasks/activateSOSSession`.
- Cloud Tasks retry policy: 3 retries, initial backoff 10 s, max backoff 60 s, max attempts 4.
  After 4 failures the task is dead-lettered to a `sos-activate-dlq` queue and a Cloud
  Monitoring alert fires.
- In the Firebase Emulator / test environment, Cloud Tasks is mocked: the task handler is
  called directly after the configured delay using `setTimeout` in the test harness. The
  `activateSOSSession` function itself is tested independently with direct invocation.
- Cloud Tasks requires a service account with `cloudtasks.tasks.create` permission and a
  pre-provisioned queue. These are infrastructure prerequisites, tracked as task 0.1.

---

### Decision 3 — bcrypt Cost Factor: Amended to 10 with Normal-Login Bypass

**Resolution: bcrypt cost factor = 10. The UX penalty is removed from the normal login path
by separating normal-PIN verification from duress-PIN verification.**

**Why the original cost=8 decision was wrong:**

A brute-force analysis against a leaked hash reveals the problem with relying on cost=8 for a
numeric PIN:

| PIN length | Combinations | Cost=8 (RTX 4090 @ 95k/s) | Cost=10 (RTX 4090 @ 24k/s) |
|---|---|---|---|
| 4 digits | 10,000 | **0.1 seconds** | 0.4 seconds |
| 6 digits | 1,000,000 | 10.5 seconds | **42 seconds** |
| 8 digits | 100,000,000 | ~17.5 minutes | **~70 minutes** |

GPU figures from published hashcat benchmarks (RTX 4090 is the current consumer adversarial
baseline for an offline attack on an extracted hash). A 4-digit duress PIN at cost=8 falls in
0.1 seconds offline. Even cost=10 does not adequately protect a 4-digit PIN. This is why Req
10.1 now requires a 6-digit minimum — the worst case at cost=10 is 42 seconds for exhaustive
search of 6-digit space, which at least requires meaningful compute time rather than instant
cracking.

**Why "rate-limiting" doesn't help here:**

The Req 11.6 rate-limit (5 sessions/10 min) applies to `createSOSSession` calls — SOS creation,
not PIN verification. PIN verification runs entirely on-device via `bcrypt.compare` in the PWA.
There is no server call during PIN entry. An attacker who has extracted the hash from Firestore
(or from the device's IndexedDB) runs bcrypt offline on their own hardware. No rate-limit touches
that path. Req 11.7 (newly added) documents this boundary explicitly.

**The UX conflict with cost=10 and constant-time evaluation:**

The original cost=8 choice was motivated by: cost=10 → ~250ms P95 → every PIN attempt
(including normal logins) takes ≥250ms. That is perceivable under stress.

**Resolution:** decouple the normal-PIN path from the duress-PIN path. The constant-time
requirement only applies between the *wrong-PIN* path and the *duress-PIN* path (an observer
watching for the decoy-screen trigger). The *normal-PIN* path is allowed to be fast — the user
successfully entering their real PIN is not a timing attack surface because the outcome (navigate
to home) is identical regardless of how long it takes.

**Revised constant-time design:**

```
firedAt = new Date()

// Fast path: check normal PIN first (cheap string comparison against bcrypt hash,
// OR — if normal login uses a different mechanism — skip bcrypt entirely for normal PIN)
// Normal login does NOT use bcrypt in most mobile app designs; it uses a server-verified
// session token. We assume the normal RAKSHA PIN is verified server-side.
// Therefore the bcrypt hash in silentActivationConfig is ONLY for the duress PIN.

duressMatch = await bcrypt.compare(candidatePin, duressHash)  // cost=10, ~250ms

// Timing parity: wrong PIN and duress PIN paths must be indistinguishable
// Normal PIN: server verification is a separate network call — not subject to this timing
// bound because the success outcome (home screen) is visually unambiguous anyway.
// Only wrong-PIN vs duress-PIN needs constant-time treatment.

deadline = firedAt + measuredP95BcryptCost10Ms + 20
await sleep(max(0, deadline - Date.now()))

if duressMatch:
  renderDecoyScreen()
  triggerDetector.onTriggerFired('duress_pin', firedAt)
else:
  // Not duress PIN. Check normal PIN via server session verification (separate flow).
  // This path takes longer (network round-trip) but its outcome is visible (home vs wrong-PIN)
  // so timing does not leak duress state.
  verifyNormalPinViaServer(candidatePin)
```

Key insight: the timing side-channel concern is specifically *wrong-PIN vs duress-PIN* — both
show an error-like screen quickly. The *normal-PIN* path shows the home screen which is
visually distinct regardless of timing, so an observer already knows normal-PIN succeeded
from the UI outcome. Separating the paths means cost=10 only penalises wrong-PIN attempts
(rare in practice for someone who knows their PIN) and duress-PIN entry (deliberate, user
is expecting a slight pause).

**P95 at cost=10:** ~250ms on Pixel 6a. The timing-parity deadline in Req 4.6 is now
`firedAt + 270ms` (P95 + 20ms margin). Wrong-PIN and duress-PIN paths both render within
270ms. This is the new bound; the 30ms relative tolerance from Req 4.6 still holds
(max |Δt| ≤ 30ms across 50 samples, measured against the ~250ms baseline).

**Minimum PIN length:** raised to 6 digits (Req 10.1) in conjunction with cost=10. Together,
exhaustive offline search of the full 6-digit space at cost=10 requires ~42 seconds on a high-end
consumer GPU. This is not brute-force-proof, but it is meaningfully above "instant". Phase 2
should migrate to server-side verification (per Req 11.7) to close the offline-extract vector
entirely; that requires the normal-login refactor described above to be complete first.

---

### Decision 4 — Phrase Matcher Library: sherpa-onnx + vad-web

**Resolution: `sherpa-onnx` (WASM keyword spotter) + `@ricky0123/vad-web` (VAD pre-filter).**

The custom MFCC cosine-similarity comparator described in the initial draft was unbounded in
scope and had no existing test corpus. Two alternatives were evaluated:

| Option | On-device | Bundle | Notes |
|---|---|---|---|
| Web Speech API | ❌ | — | Routes audio to Google; violates Req 5.2 |
| `@xenova/transformers` (Whisper Tiny) | ✅ | ~40 MB | Exceeds bundle budget; full ASR overkill for keyword |
| Custom MFCC + cosine similarity | ✅ | ~1 MB | No test corpus; high implementation risk |
| **`sherpa-onnx` WASM keyword spotter** | **✅** | **~3–4 MB** | Pre-trained keyword model; proven on-device; composable |

`sherpa-onnx` provides a WASM build with a small `kws.onnx` keyword-spotting model fine-tuned
for short phrases. The model runs on CPU in a Web Worker, produces per-frame keyword scores, and
fires a callback when the configured keyword sequence exceeds the threshold.

`vad-web` (`@ricky0123/vad-web`) runs as the upstream pre-filter: it suppresses processing
during silence, reducing CPU load by ~70% during quiet periods of a call. Audio flows to
`sherpa-onnx` only during detected speech frames.

**The enrolled phrase is stored as a `sherpa-onnx` keyword token sequence** (not raw audio, not
text) encrypted with AES-256-GCM as described in the phrase template storage design above. The
ONNX model weights are bundled with the app and are not per-user; only the keyword token
sequence is user-specific.

**WASM bundle breakdown:**
- `sherpa-onnx` WASM runtime: ~2.0 MB
- `kws.onnx` keyword model: ~1.2 MB  
- `vad-web` WASM + silero-vad model: ~0.6 MB
- Total: ~3.8 MB — within the 5 MB budget

**The empirical validation requirement from Req 5.4 still applies.** The implementing engineer
must measure FPR and FNR for `sherpa-onnx` on the target phrase types before declaring the
confidence threshold settled. The 80% placeholder in Req 5.4 is now specifically a `sherpa-onnx`
keyword score threshold (range 0.0–1.0); the validation protocol remains as specified.
