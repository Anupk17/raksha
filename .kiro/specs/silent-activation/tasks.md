# Implementation Plan — Discreet Silent Activation

## Overview

Implementation of the Discreet Silent Activation system. The plan proceeds in strict dependency
order: shared types first, server-side Cloud Functions second (because they own the SOSSession
contract), client-side detection modules third (because they depend on the server interface),
and integration tests last. No phase begins before all file outputs from the prior phase exist
and their unit tests pass.

Stack: React + TypeScript PWA (client), Android TWA native bridge (power-button only), Firebase
Cloud Functions (Node 18, Admin SDK), Firestore, Google Cloud Tasks, `sherpa-onnx` WASM +
`@ricky0123/vad-web` (phrase detection), bcrypt cost=10 (duress-PIN hashing only; normal-PIN
uses server-side verification), IndexedDB (offline queue), vitest + fast-check (unit + property
tests), Firebase Emulator Suite (integration tests).

**Prerequisites before any code is written (Task 0):**
- Cloud Tasks queue `sos-session-activate` provisioned in the GCP project
- Dead-letter queue `sos-activate-dlq` provisioned
- Cloud Monitoring alert on `sos-activate-dlq` queue depth > 0
- Service account with `cloudtasks.tasks.create` permission wired to the Cloud Functions runtime

---

## Implementation Status Summary

### ✅ DONE
_(nothing yet — this is the starting state)_

### ❌ NOT DONE — All Tasks

| Phase | What to build | Key tests |
|---|---|---|
| 0 — Infrastructure | Cloud Tasks queue + DLQ + alert | Manual verification |
| 1 — Foundation | `types/sosSession.ts`, timestamp guard reuse | 8 |
| 2 — Server: createSOSSession | Validation, idempotency, rate-limit, document creation, Cloud Tasks enqueue | 18 |
| 3 — Server: activateSOSSession | Cloud Tasks handler, conditional `countdown→active` transaction | 8 |
| 4 — Server: cancelSOSSession | Conditional `countdown→cancelled` transaction, idempotent cancel | 7 |
| 5 — Server: testTrigger | No-op validation endpoint | 4 |
| 6 — Server: security rules | sosSessions deny-all-client-writes, user read rules | — |
| 7 — Client: offline queue | IndexedDB queue, enqueue/dequeue, connectivity flush | 10 |
| 8 — Client: countdown manager | 10s timer, cancel gate, escalation, P19/P20/P21/P27 | 9 |
| 9 — Client: trigger detector | Mutual exclusion, Android power-button, earbud | 8 |
| 10 — Client: duress PIN | Constant-time evaluation, decoy screen, P22 | 6 |
| 11 — Client: phrase matcher | sherpa-onnx + vad-web pipeline, enrolment, voice guard | 7 |
| 12 — Client: configuration UI | silentActivationConfig, validation, test mode | 6 |
| 13 — Integration tests | End-to-end: trigger → SOSSession → active + race condition | 14 |
| 14 — Checkpoint | Full suite green, properties verified | — |

---

## Detailed Task List

---

### Task 0 — Infrastructure Prerequisites

These are GCP/Firebase console operations, not code. Must be complete before Task 2 begins.
A CI check in Task 2 verifies the queue exists before any test that exercises Cloud Tasks.

- [ ] 0.1 Provision Cloud Tasks queue `sos-session-activate` in the project's region
  - Max concurrent dispatches: 1000; retry policy: 3 retries, 10s initial backoff, 60s max backoff
- [ ] 0.2 Provision dead-letter queue `sos-activate-dlq`
- [ ] 0.3 Create Cloud Monitoring alerting policy: alert when `sos-activate-dlq` queue depth > 0
- [ ] 0.4 Grant Cloud Functions service account `roles/cloudtasks.enqueuer` on the queue
- [ ] 0.5 Document queue name and region as environment variables in `.env.example`:
  `CLOUD_TASKS_QUEUE`, `CLOUD_TASKS_LOCATION`, `CLOUD_TASKS_HANDLER_URL`

---

### Task 1 — Foundation: Shared Types and Guards

**Output files:**
- `functions/src/types/sosSession.ts`
- `functions/src/types/sosSession.test.ts`

- [ ] 1.1 Define TypeScript interfaces in `sosSession.ts`:
  - `SOSSession`, `SOSSessionStatus` union, `TriggerType` union, `HashedLocation`,
    `CreateSOSSessionPayload`, `CreateSOSSessionResponse`
  - All timestamp fields typed as `Date` with JSDoc: `// NEVER Firestore Timestamp`
  - Export a `SOS_SESSION_STATUS` const object for use as a runtime enum guard

- [ ] 1.2 Confirm `assertDate` and `assertDateOrNull` from `utils/assertDate.ts` cover the
  `cancelledAt | null` and `activatedAt | null` pattern — no new utility code needed;
  add a note in `sosSession.ts` referencing the shared guard

- [ ] 1.3 Write unit tests in `sosSession.test.ts`:
  - `SOSSessionStatus` union contains exactly `countdown`, `active`, `cancelled` (no more, no less)
  - `TriggerType` union contains exactly the four permitted values
  - `CreateSOSSessionPayload` shape: all required fields present, no extras
  - `SOS_SESSION_STATUS` runtime guard correctly accepts valid and rejects invalid strings
  - **Target: 8 tests**

---

### Task 2 — Cloud Function: createSOSSession

**Output files:**
- `functions/src/functions/createSOSSession.ts`
- `functions/src/functions/createSOSSession.test.ts`

Depends on: Task 1 complete, Task 0.4 complete (queue exists for Cloud Tasks enqueue).

- [ ] 2.1 Implement authentication check — reject (401) if `context.auth` is absent

- [ ] 2.2 Implement `triggeredAt` validation:
  - Parse ISO 8601 string to `new Date()`
  - Reject if `triggeredAt > serverReceiveTime + 5000ms` (future timestamp)
  - Reject if `triggeredAt < serverReceiveTime - 72 * 3600 * 1000` (older than 72 hours)
  - Reject if `isNaN(triggeredAt.getTime())`
  - All rejections return a descriptive 400 error with the field name and reason

- [ ] 2.3 Implement `syncedAt` parsing and `syncDelayMinutes` / `lateSyncFlag` computation:
  - `syncDelayMinutes = Math.round((syncedAtMs - triggeredAtMs) / 60000)`
  - `lateSyncFlag = syncDelayMinutes >= 60`

- [ ] 2.4 Implement `triggerType` validation — reject (400) if not in the four permitted values

- [ ] 2.5 Implement idempotency check inside a Firestore transaction:
  - Query `sosSessions` where `userId == callerUid` and `triggeredAt` within ±5s
  - If found: return existing `sessionId` + `status` with `alreadyExists: true`
  - Transaction prevents TOCTOU with a concurrent identical call

- [ ] 2.6 Implement rate-limit check inside the same transaction:
  - Count sessions for `userId` created in the last 10 minutes
  - If count ≥ 5: reject (429), log `{ userId: hash(userId), windowCount: count }`
  - Do not expose the raw `userId` in logs

- [ ] 2.7 Implement document creation:
  - Write `SOSSession` with `status: 'countdown'`, `triggeredAt` from validated client value,
    `createdAt: new Date()` (server time), `syncDelayMinutes`, `lateSyncFlag`, all null fields null
  - All timestamp writes use `new Date()` — never `admin.firestore.Timestamp`
  - Creation and idempotency check are atomic in the same Firestore transaction

- [ ] 2.8 Implement Cloud Tasks enqueue:
  - Task payload: `{ sessionId }`
  - `scheduleTime`: `max(serverReceiveTime + 100, triggeredAt.getTime() + 10_000)` ms from epoch
    (minimum 100ms future to avoid immediate dispatch; late-sync sessions get 0ms extra delay)
  - Queue: `CLOUD_TASKS_QUEUE` env var; handler URL: `CLOUD_TASKS_HANDLER_URL`
  - If enqueue fails: log error, mark session `status: 'enqueue_failed'` (new terminal status),
    return error — do not silently create a session that will never activate

- [ ] 2.9 Implement structured audit log write:
  - `{ sessionId, userId: sha256(userId).slice(0,16), triggerType, triggeredAt: ISO, createdAt: ISO, lateSyncFlag }`
  - Raw userId, raw GPS coordinates, and sub-second `triggeredAt` precision are omitted

- [ ] 2.10 Write unit tests in `createSOSSession.test.ts`:
  - Rejects unauthenticated request (401)
  - Rejects future `triggeredAt` (400)
  - Rejects `triggeredAt` older than 72 hours (400)
  - Rejects unknown `triggerType` (400)
  - Creates document with `status: 'countdown'` on valid input
  - `triggeredAt` in created document matches client payload (P23)
  - `lateSyncFlag: true` when `syncDelayMinutes >= 60` (P24)
  - `lateSyncFlag: false` for real-time trigger
  - Idempotent: second call with same `userId`+`triggeredAt` returns existing `sessionId` (P29)
  - Rate-limit: 6th call within 10 minutes is rejected with 429 (P30)
  - Enqueues Cloud Tasks task with correct `scheduleTime` for real-time trigger
  - Enqueues Cloud Tasks task with `scheduleTime = serverReceiveTime + 100ms` for late-sync trigger
  - Marks `enqueue_failed` when Cloud Tasks enqueue throws
  - Audit log contains hashed userId, not raw userId
  - `createdAt` is server time, not client `triggeredAt`
  - Rejects unauthenticated request even if payload is otherwise valid (defense in depth)
  - No Firestore `Timestamp` values in written document (native Date only)
  - **Target: 18 tests**

---

### Task 3 — Cloud Function: activateSOSSession (Cloud Tasks handler)

**Output files:**
- `functions/src/functions/activateSOSSession.ts`
- `functions/src/functions/activateSOSSession.test.ts`

Depends on: Task 2 complete.

- [ ] 3.1 Implement Cloud Tasks HTTP handler (POST endpoint, not callable):
  - Verify request origin is Cloud Tasks (check `X-CloudTasks-QueueName` header)
  - Parse `{ sessionId }` from request body

- [ ] 3.2 Read SOSSession document; deserialize all timestamps with `assertDate` / `assertDateOrNull`

- [ ] 3.3 Implement conditional transaction:
  - Read document inside transaction
  - If `status !== 'countdown'`: log `{ sessionId, actualStatus }`, throw `ABORT_NOT_COUNTDOWN`
  - If `status === 'countdown'`: write `{ status: 'active', activatedAt: new Date(), updatedAt: new Date() }`

- [ ] 3.4 Handle `ABORT_NOT_COUNTDOWN`: log and return HTTP 200 to Cloud Tasks
  (returning 2xx tells Cloud Tasks the task succeeded — it does not retry)

- [ ] 3.5 On Firestore transient error: return HTTP 500 so Cloud Tasks retries per the retry policy

- [ ] 3.6 Write unit tests in `activateSOSSession.test.ts`:
  - Transitions `countdown → active`, sets `activatedAt` to non-null (P32)
  - `status` and `activatedAt` are written atomically — no intermediate `active`/null state
  - Aborts and returns 200 when status is already `cancelled` (P25)
  - Aborts and returns 200 when status is already `active` (idempotent retry safety)
  - Rejects request with missing or invalid `X-CloudTasks-QueueName` header
  - Returns 500 on Firestore error (Cloud Tasks will retry)
  - `assertDate` guard fires and throws if `triggeredAt` deserializes as non-Date
  - `activatedAt` is a native Date, not a Firestore Timestamp
  - **Target: 8 tests**

---

### Task 4 — Cloud Function: cancelSOSSession

**Output files:**
- `functions/src/functions/cancelSOSSession.ts`
- `functions/src/functions/cancelSOSSession.test.ts`

Depends on: Task 2 complete.

- [ ] 4.1 Implement authentication check (401 if unauthenticated)

- [ ] 4.2 Read session; verify `session.userId === callerUid` (403 if not)

- [ ] 4.3 Implement conditional transaction:
  - `status === 'cancelled'` → return `{ cancelled: true, alreadyWas: true }` (idempotent success)
  - `status === 'active'` → return 409 `{ cancelled: false, reason: 'ALREADY_ESCALATED' }`
  - `status === 'countdown'` → write `{ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() }`

- [ ] 4.4 Write unit tests in `cancelSOSSession.test.ts`:
  - Rejects unauthenticated request (401)
  - Rejects mismatched userId (403)
  - Transitions `countdown → cancelled`, records `cancelledAt`
  - Idempotent: second cancel on already-cancelled returns success (P26 variant)
  - Returns 409 when status is already `active` (P26)
  - `cancelledAt` is native Date, not Firestore Timestamp
  - `cancelled` state is terminal — transaction cannot write any other status
  - **Target: 7 tests**

---

### Task 5 — Cloud Function: testTrigger

**Output files:**
- `functions/src/functions/testTrigger.ts`
- `functions/src/functions/testTrigger.test.ts`

Depends on: Task 2 complete (shares validation logic).

- [ ] 5.1 Implement callable function: runs the same `triggeredAt` + `triggerType` validation as
  `createSOSSession`, but writes nothing to Firestore and returns
  `{ sessionId: 'test_' + uuid(), status: 'countdown' }`

- [ ] 5.2 Log each invocation for abuse monitoring (same hashed-userId format as Task 2.9)

- [ ] 5.3 Write unit tests:
  - Returns synthesized `sessionId` starting with `test_`
  - Does not write any Firestore document
  - Applies same validation rules as `createSOSSession` (future timestamp rejected, etc.)
  - Rejects unauthenticated request
  - **Target: 4 tests**

---

### Task 6 — Firestore Security Rules Update

**Output files:** `firestore.rules` (amend existing file)

Depends on: Task 1 complete (SOSSession schema defined).

- [ ] 6.1 Add `sosSessions` collection rules:
  ```
  match /sosSessions/{sessionId} {
    allow read:   if request.auth != null && resource.data.userId == request.auth.uid;
    allow create: if false;
    allow update: if false;
    allow delete: if false;
  }
  ```
  No client creates or updates — Cloud Functions own all writes via Admin SDK.

- [ ] 6.2 Verify `users/{userId}` rule already permits owner read/write of `silentActivationConfig`
  — no change needed if the existing user document rule covers all fields.

- [ ] 6.3 Manually verify rules in Firebase Emulator with a security rules test:
  - Owner can read own session
  - Non-owner cannot read session
  - Client cannot create, update, or delete a session document

---

### Task 7 — Client: Offline Queue

**Output files:**
- `client/src/silentActivation/offlineQueue.ts`
- `client/src/silentActivation/offlineQueue.test.ts`

Depends on: Task 1 complete (payload type defined).

- [ ] 7.1 Implement IndexedDB wrapper with schema version 1:
  - Object store: `sos_queue`, keyPath: `id` (auto-incremented), indexes on `queuedAt`

- [ ] 7.2 Implement `enqueue(payload: CreateSOSSessionPayload): Promise<void>`:
  - If queue length ≥ 10: drop oldest entry, log drop with ISO `queuedAt` of dropped entry
  - Append `{ id, payload, queuedAt: new Date().toISOString(), retryCount: 0 }`

- [ ] 7.3 Implement `enqueueAndFlush(payload)`: attempts network call first; on `NetworkError`
  falls through to `enqueue`. Returns `CreateSOSSessionResponse` or undefined (if queued).

- [ ] 7.4 Implement `flush()`: reads queue FIFO, calls `createSOSSession` for each entry:
  - On success: delete entry from queue
  - On failure: `retryCount++`; if `retryCount >= 3` schedule exponential backoff
    (30s base, doubling, max 5 min); else retry on next `flush()` call
  - Flush is serialised — only one in-flight network call at a time

- [ ] 7.5 Implement `init()`: called at app startup; registers `window.addEventListener('online')`
  listener that calls `flush()` after 5 seconds; calls `flush()` immediately if already online

- [ ] 7.6 Write unit tests (vitest, fake IndexedDB via `fake-indexeddb`):
  - `enqueue` persists entry to IndexedDB
  - `enqueue` drops oldest when queue length reaches 10, logs the drop (P28 capacity)
  - `flush` calls `createSOSSession` for each queued entry in FIFO order
  - `flush` dequeues entry on success; retains on failure
  - `flush` schedules exponential backoff after 3 consecutive failures
  - Entry survives a simulated app restart (re-open IndexedDB connection; entry still present) (P28)
  - `enqueueAndFlush` does not persist to IndexedDB when network call succeeds
  - Cancelled countdown does not result in any `enqueue` call (P27 — tested at CountdownManager
    boundary; this test confirms `offlineQueue.enqueue` is never called on cancel path)
  - `init` registers `online` event listener exactly once
  - Parallel `flush` calls do not result in duplicate `createSOSSession` calls
  - **Target: 10 tests**

---

### Task 8 — Client: CountdownManager

**Output files:**
- `client/src/silentActivation/countdownManager.ts`
- `client/src/silentActivation/countdownManager.test.ts`

Depends on: Task 7 complete (escalation calls `offlineQueue.enqueueAndFlush`).

- [ ] 8.1 Implement `CountdownManager` class per the design:
  - `start(type, firedAt, onComplete)`: set 10_000ms timer, optional haptic pulse
  - `cancel()`: clear timer, call `onComplete`, produce no network calls or Firestore writes (P20)
  - `escalate()`: build payload with `triggeredAt = firedAt.toISOString()`,
    `syncedAt = new Date().toISOString()`, call `offlineQueue.enqueueAndFlush(payload)` (P21)

- [ ] 8.2 `firedAt` must be the timestamp passed into `start()`, not `new Date()` inside `escalate()`

- [ ] 8.3 `escalate()` calls `onComplete` before the async network call so `TriggerDetector`
  releases the `countdownActive` flag immediately on escalation

- [ ] 8.4 Write unit tests (vitest, fake timers via `vi.useFakeTimers()`):
  - `start` followed by timer expiry calls `escalate` — `offlineQueue.enqueueAndFlush` invoked (P21)
  - `start` followed by `cancel` before expiry: `offlineQueue.enqueueAndFlush` NOT called (P20/P27)
  - `cancel` after expiry (race): treated as a no-op — no double-escalation
  - `escalate` payload has `triggeredAt = firedAt.toISOString()` not `new Date()` at escalation time
  - `escalate` payload has `syncedAt` ≥ `triggeredAt` (syncedAt is never before firedAt)
  - `onComplete` is called by `cancel()` synchronously before any async work
  - `onComplete` is called by `escalate()` before awaiting the network call
  - Timer is cleared on `cancel()` — no late-fire after cancellation
  - Haptic call (`navigator.vibrate`) is not made when `navigator.vibrate` is absent
  - **Target: 9 tests**

---

### Task 9 — Client: TriggerDetector and Gesture Sub-Detectors

**Output files:**
- `client/src/silentActivation/triggerDetector.ts`
- `client/src/silentActivation/triggerDetector.test.ts`

Depends on: Task 8 complete (`CountdownManager` is the dependency).

- [ ] 9.1 Implement `TriggerDetector` class:
  - `countdownActive` flag; `onTriggerFired(type, firedAt)` drops if flag is set (P19)
  - `onTriggerFired` sets flag, calls `countdownManager.start(type, firedAt, () => flag = false)`

- [ ] 9.2 Implement `PowerButtonSubDetector` (Android TWA only):
  - Check for `window.RakshaBridge` at construction; if absent, do not register listener
  - `CircularBuffer(maxSize=10, windowMs=2000)` tap tracker
  - Validate: `n >= configuredTapCount`, `n <= 8`, `maxGap(taps) <= 1000ms`
  - On valid sequence: call `triggerDetector.onTriggerFired('power_button', new Date())`

- [ ] 9.3 Implement `EarbudSubDetector`:
  - Register Media Session `previoustrack` action and `keydown` `MediaTrackPrevious` fallback
  - `CircularBuffer(maxSize=5, windowMs=1500)` click tracker
  - 3 clicks within window → `triggerDetector.onTriggerFired('earbud', new Date())`
  - Exactly one Countdown_Window even if both events fire simultaneously (P19)

- [ ] 9.4 Write unit tests:
  - `TriggerDetector` drops second trigger while countdown is active (P19)
  - `TriggerDetector` allows new trigger after `onComplete` callback fires
  - `PowerButtonSubDetector` fires trigger on exactly `configuredTapCount` taps within 2s
  - `PowerButtonSubDetector` does not fire on > 8 taps (anti-pocket guard)
  - `PowerButtonSubDetector` does not fire when any inter-tap gap exceeds 1000ms
  - `PowerButtonSubDetector` does not register listener when `RakshaBridge` is absent
  - `EarbudSubDetector` fires on triple-click within 1500ms
  - `EarbudSubDetector` produces at most one trigger from simultaneous events
  - **Target: 8 tests**

---

### Task 10 — Client: DuressPIN and Decoy Screen

**Output files:**
- `client/src/silentActivation/pinEntry.ts`
- `client/src/silentActivation/pinEntry.test.ts`

Depends on: Task 9 complete.

- [ ] 10.1 Implement constant-time PIN evaluation per the amended Decision 3 design:
  - Capture `firedAt = new Date()` as first line of handler
  - Run `duressMatch = await bcrypt.compare(candidatePin, duressHash)` (cost=10, only hash)
  - If `duressHash` is null, run `bcrypt.compare(candidatePin, STATIC_DUMMY_HASH)` as padding
  - Startup calibration: 5 samples of bcrypt cost=10, P95 cached as `measuredP95BcryptCost10Ms`
  - `deadline = firedAt.getTime() + measuredP95BcryptCost10Ms + 20`
  - `await sleep(Math.max(0, deadline - Date.now()))` before rendering wrong-PIN or decoy
  - Normal-PIN verification is a separate server call — it does NOT participate in this
    constant-time block (see design.md §Decision 3 amendment)

- [ ] 10.2 Implement routing after deadline:
  - `duressMatch` → `renderDecoyScreen()` then `triggerDetector.onTriggerFired('duress_pin', firedAt)`
  - not `duressMatch` → if candidatePin matches normal PIN (via server): navigate to home;
    else: `renderWrongPinError()`

- [ ] 10.3 Implement `renderDecoyScreen()`: renders a UI state identical to wrong-PIN error;
  back-button and swipe navigation are suppressed for the session

- [ ] 10.4 Write unit tests:
  - Both `bcrypt.compare` calls are made regardless of which path is taken (timing parity)
  - `firedAt` passed to `onTriggerFired` equals the timestamp captured before `Promise.all`
  - Duress-PIN path renders decoy screen (not home, not wrong-PIN error)
  - Wrong-PIN path renders wrong-PIN error (not decoy screen, not home)
  - Normal-PIN path navigates to home
  - Back-navigation is suppressed on the decoy screen
  - **Target: 6 tests (P22 is a device integration test — see Task 13)**

---

### Task 11 — Client: Phrase Matcher (sherpa-onnx + vad-web)

**Output files:**
- `client/src/silentActivation/phraseEnrolment.ts`
- `client/src/silentActivation/phraseMatchWorker.ts`
- `client/src/silentActivation/phraseDetector.ts`
- `client/src/silentActivation/phraseDetector.test.ts`
- `client/src/silentActivation/phraseEnrolment.test.ts`

Depends on: Task 9 complete. **Note:** `sherpa-onnx` and `@ricky0123/vad-web` must be added
as production dependencies with pinned versions before this task begins.

- [ ] 11.1 Implement `phraseEnrolment.ts`:
  - Accept audio buffer from microphone at enrolment time
  - Run buffer through `sherpa-onnx` to extract keyword token sequence
  - Encrypt token sequence with AES-256-GCM, key = HKDF(userId + deviceSalt)
  - Store encrypted token sequence in IndexedDB store `phrase_template`
  - Delete plaintext token sequence and audio buffer from memory on completion
  - Ref: `utils/aesGcm.ts` for AES-256-GCM (reused from Evidence Trail)

- [ ] 11.2 Implement `phraseMatchWorker.ts` (Web Worker):
  - Initialise `sherpa-onnx` WASM runtime and `vad-web` on worker start
  - Receive audio frames from main thread via `postMessage`
  - Pipeline: `vad-web` silence filter → `sherpa-onnx` keyword score per frame
  - Emit `{ type: 'keyword_detected', score }` to main thread when score > threshold
  - Emit `{ type: 'ready' }` when WASM modules are loaded

- [ ] 11.3 Implement `phraseDetector.ts`:
  - `start()`: request microphone via `getUserMedia`, pipe to worker, register call-state listener
  - `stop()`: suspend microphone track, terminate worker audio pipeline
  - Voice isolation guard: `CircularBuffer(maxSize=3, windowMs=30000)`; trigger on 3rd detection
  - On trigger: call `triggerDetector.onTriggerFired('duress_phrase', new Date())`
  - Call-state listener (Android TWA bridge or `audiocapture` change): call `stop()` when call ends

- [ ] 11.4 Write unit tests:
  - `phraseEnrolment` stores encrypted (not plaintext) token sequence in IndexedDB
  - `phraseEnrolment` zeroes the plaintext buffer after encryption
  - `phraseDetector` does not trigger on a single detection (voice isolation guard)
  - `phraseDetector` triggers on 3rd detection within 30s
  - `phraseDetector` resets detection buffer when the 30s window expires without 3 detections
  - `phraseDetector` calls `stop()` immediately when call-end event fires
  - In-progress Countdown_Window continues when `stop()` is called (phrase trigger already fired)
  - **Target: 7 tests (P31 is an integration test — see Task 13)**

---

### Task 12 — Client: Configuration UI and Validation

**Output files:**
- `client/src/silentActivation/activationConfig.ts`
- `client/src/silentActivation/activationConfig.test.ts`

Depends on: Tasks 9–11 complete (all detectors exist to enable/disable).

- [ ] 12.1 Implement `validateActivationConfig(config)`:
  - At least one trigger type enabled
  - Duress PIN: **6–8 digits** (minimum raised from 4), numeric only, not equal to normal PIN
  - Duress phrase: 3–50 characters, at least two words
  - Power-button tap count: integer 3–7
  - Returns typed validation error list, not exceptions

- [ ] 12.2 Implement `saveActivationConfig(config)`:
  - Hash duress PIN with bcrypt **cost=10** before writing; zero plaintext from memory
  - Write `silentActivationConfig` field on user's Firestore document
  - Update `On_Device_Phrase_Matcher` reference template within 500ms of phrase change

- [ ] 12.3 Implement test-mode integration: `testTrigger` callable instead of `createSOSSession`
  when `testMode: true` flag is passed through the trigger chain

- [ ] 12.4 Write unit tests:
  - `validateActivationConfig` rejects when no triggers enabled
  - `validateActivationConfig` rejects duress PIN that matches normal PIN
  - `validateActivationConfig` rejects duress PIN with fewer than 6 digits (not 4)
  - `validateActivationConfig` rejects duress PIN outside 6–8 digit range
  - `validateActivationConfig` rejects phrase shorter than 2 words
  - `saveActivationConfig` hashes PIN with bcrypt cost=10 before writing; plaintext not present in written object
  - Test mode routes to `testTrigger`, not `createSOSSession`
  - **Target: 7 tests**

---

### Task 13 — Integration Tests

**Output files:**
- `client/src/tests/integration/silentActivation.integration.test.ts`

Depends on: All Tasks 1–12 complete. Runs against Firebase Emulator + mock Cloud Tasks handler.

- [ ] 13.1 **Happy path — earbud trigger → SOSSession active**:
  Simulate triple-click → verify `countdown` document created → wait 10s (fake timers) →
  verify `active` document with `activatedAt` set (P32)

- [ ] 13.2 **Happy path — cancellation within countdown**:
  Simulate trigger → simulate Cancel_Gesture at T=3s → verify no SOSSession document
  was created / document status is `cancelled` → verify zero extra Firestore writes (P20)

- [ ] 13.3 **Race: cancellation vs activation (cancellation wins)**:
  Create `countdown` session → call `cancelSOSSession` and trigger `activateSOSSession`
  simultaneously via Firestore Emulator → verify exactly one winner, no torn state (P25/P26)

- [ ] 13.4 **Race: cancellation vs activation (activation wins)**:
  Inverse of 13.3 — `activateSOSSession` commits first → `cancelSOSSession` returns 409 (P26)

- [ ] 13.5 **Idempotency (P29)**:
  Call `createSOSSession` twice with the same `userId` and `triggeredAt` → verify single document

- [ ] 13.6 **Rate-limit (P30)**:
  Call `createSOSSession` 6 times within 10 minutes → 6th returns 429

- [ ] 13.7 **Offline queue durability (P28)**:
  Enqueue payload → simulate app restart by clearing in-memory state → reinitialise `offlineQueue`
  → verify payload still present in IndexedDB

- [ ] 13.8 **Late-sync (P24)**:
  Enqueue payload with `triggeredAt` 90 minutes ago → flush → verify `lateSyncFlag: true`
  and `syncDelayMinutes ≈ 90` on created document

- [ ] 13.9 **Decoy screen timing parity (P22)** — device integration test, marked `@slow`:
  Run 50 wrong-PIN submissions and 50 duress-PIN submissions; assert `max(|Δt|) ≤ 30ms`

- [ ] 13.10 **No phrase audio transmission (P31)**:
  Start phrase detector with network request interceptor; play audio that matches the duress phrase;
  assert zero outbound requests containing audio data or phrase text

- [ ] 13.11 **Offline cancel — no queue entry (P27)**:
  Simulate trigger offline → simulate Cancel_Gesture before countdown expires →
  assert zero entries in IndexedDB queue

- [ ] 13.12 **Security rules — owner read, non-owner denied**:
  Create SOSSession via Admin SDK; attempt read as owner (should succeed); attempt read as
  different user (should be denied by Firestore rules)

- [ ] 13.13 **Security rules — client cannot create or update**:
  Attempt `db.collection('sosSessions').doc().set(...)` from client SDK → expect security denial

- [ ] 13.14 **`activatedAt` atomicity (P32)**:
  Read SOSSession documents 100 times during activation window (Firestore Emulator);
  assert no document is observed with `status: 'active'` and `activatedAt: null`

  **Target: 14 tests**

---

### Task 14 — Final Checkpoint

- [ ] 14.1 Run full test suite: `npx vitest run` in `functions/` — all tests must pass
- [ ] 14.2 Run full test suite in `client/` — all tests must pass
- [ ] 14.3 Confirm properties P19–P32 are each covered by at least one named test
- [ ] 14.4 Confirm no `Firestore.Timestamp` import or usage anywhere in `sosSession`-related files
- [ ] 14.5 Confirm bcrypt cost=10 is hardcoded (not read from config) in `pinEntry.ts` and `activationConfig.ts`
- [ ] 14.6 Confirm `iOS` / `RakshaBridge` absence guard is present in `PowerButtonSubDetector` —
  no listener registration on non-TWA platforms
- [ ] 14.7 Confirm `createSOSSession` never logs raw `userId`, raw GPS, or plaintext duress phrase

---

## Task Dependency Graph

```
0.1–0.5 (infra)
    │
    ▼
1.1–1.3 (types)
    │
    ├──► 2.1–2.10 (createSOSSession)
    │         │
    │         ├──► 3.1–3.6 (activateSOSSession)
    │         ├──► 4.1–4.4 (cancelSOSSession)
    │         └──► 5.1–5.3 (testTrigger)
    │
    └──► 6.1–6.3 (security rules)
              │
              ▼
         7.1–7.6 (offlineQueue)
              │
              ▼
         8.1–8.4 (countdownManager)
              │
              ▼
         9.1–9.4 (triggerDetector + gesture sub-detectors)
              │
              ├──► 10.1–10.4 (duressPIN)
              └──► 11.1–11.4 (phraseMatcher)
                        │
                        ▼
                   12.1–12.4 (configUI)
                        │
                        ▼
                   13.1–13.14 (integration tests)
                        │
                        ▼
                    14.1–14.7 (checkpoint)
```

---

## Notes

- `FieldValue.arrayUnion()` is prohibited everywhere in this codebase (inherited from Evidence
  Trail guardrails). No SOSSession field uses array values, so this constraint does not apply
  in practice — but it is noted to prevent future divergence.
- All timestamps use `new Date()`. Firestore `Timestamp` is never imported in `sosSession`-
  related code. The `assertDate` / `assertDateOrNull` guards from Evidence Trail are reused.
- bcrypt cost=10 is locked for this phase. The normal-login PIN path does NOT use bcrypt — it
  uses server-side session verification. Only the duress-PIN check uses bcrypt. Changing cost
  requires: (1) re-calibrating `P95_BCRYPT_MS` on the target device class, (2) re-running P22,
  (3) updating the timing bound in Req 4.6.
- Minimum duress-PIN length is **6 digits**. The 4-digit minimum from the initial draft was
  removed after a brute-force analysis showed a 4-digit PIN at any cost factor ≤ 10 falls in
  under 1 second offline on a consumer GPU. See design.md §PIN Brute-Force Analysis.
- iOS power-button trigger is out of scope for this phase. The `RakshaBridge` guard in
  `PowerButtonSubDetector` makes this a compile-time-safe no-op on non-Android platforms.
- `sherpa-onnx` and `@ricky0123/vad-web` must be added with pinned exact versions before
  Task 11 begins. Do not use open version ranges for WASM-bundled dependencies.
- The phrase confidence threshold in Req 5.4 is still open pending empirical validation.
  Implement with a configurable value (default: 0.8) and document the validation protocol
  as a follow-up task. Task 13.10 verifies no-transmission; threshold accuracy is separate.
