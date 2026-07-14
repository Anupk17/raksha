# Requirements Document — Discreet Silent Activation

## Introduction

Discreet Silent Activation is the entry point for RAKSHA's entire safety response system. It provides multiple covert trigger mechanisms — a power-button tap sequence, a Bluetooth earbud gesture, a spoken duress phrase during a live call, and a duress PIN that opens a decoy home screen — that silently create an SOSSession and begin a 10-second countdown before escalating to a full SOS alert. The feature must function with zero or poor connectivity and must be entirely undetectable to a coercive observer.

This document incorporates the engineering guardrails established during the Evidence Trail build. Those guardrails apply here without exception: native `Date` everywhere (never Firestore `Timestamp`), Firestore transactions for every read-modify-write, append-only patterns for audit fields, and no silent data loss on any path.

The feature divides into two well-separated halves:

- **Activation_Client**: on-device PWA logic responsible for detecting trigger gestures and managing the countdown. Must work offline. No cloud round-trip during detection.
- **Activation_Server**: Firebase Cloud Functions responsible for creating the `SOSSession` document, managing its status lifecycle, and emitting hooks that downstream features (Guardian Network, evidence capture) can consume. Document creation may queue offline and sync on reconnect.

---

## Glossary

- **Activation_Client**: The on-device PWA module that detects trigger gestures and manages the pre-escalation countdown window.
- **Activation_Server**: The Firebase Cloud Functions that create and lifecycle-manage `SOSSession` documents.
- **SOSSession**: A Firestore document at `/sosSessions/{sessionId}` representing one triggered safety event, with a defined status lifecycle.
- **SOSSession_Store**: The Firestore `/sosSessions/{sessionId}` collection.
- **Trigger**: Any gesture, PIN, or phrase that initiates the Activation_Client countdown.
- **PowerButton_Sequence**: A rapid tap sequence on the device power button that activates the Trigger.
- **Earbud_Gesture**: A triple-click on a connected Bluetooth earbud that activates the Trigger.
- **Duress_Phrase**: A pre-configured spoken phrase that activates the Trigger when detected during an active phone call.
- **Duress_PIN**: A pre-configured PIN that, when entered at the device lock screen or RAKSHA login screen, opens the Decoy_Screen while silently activating the Trigger in the background.
- **Decoy_Screen**: A UI state that is visually indistinguishable from a normal "wrong PIN" or empty app state, displayed after Duress_PIN entry to avoid alerting a coercive observer.
- **Countdown_Window**: The 10-second silent period after a Trigger fires, during which the user can cancel escalation.
- **Cancel_Gesture**: The double-tap of the power button within the Countdown_Window that cancels escalation.
- **Escalation**: The transition of an SOSSession from `countdown` to `active` after the Countdown_Window expires without cancellation.
- **On_Device_Phrase_Matcher**: The on-device speech recognition component used for Duress_Phrase detection — no cloud API call is made during matching.
- **silentActivationConfig**: The sub-object on the User document that stores the user's configured trigger settings (power-button sequence sensitivity, earbud gesture preference, duress phrase text, duress PIN hash).
- **Offline_Queue**: The client-side durable queue (IndexedDB or equivalent) that holds pending SOSSession creation payloads when the device has no connectivity.
- **Session_Hook**: A stable interface point (Firestore document state, pub/sub event, or callable interface) that downstream features listen to in order to react to SOSSession status changes — this feature creates and manages the hook; it does not implement what consumes it.
- **Guardian_Network**: A downstream feature (not yet built) that pings emergency contacts when an SOSSession becomes `active`.
- **Evidence_Trigger**: A downstream feature (not yet built) that begins automatic evidence capture when an SOSSession becomes `active`.

---

## Requirements

### Requirement 1: Power-Button Tap Sequence Trigger

**User Story:** As a RAKSHA user in a dangerous situation, I want to trigger a silent SOS by pressing my power button in a specific rapid sequence, so that I can activate help without looking at my screen or alerting anyone nearby.

#### Acceptance Criteria

1. WHEN the user performs the configured power-button tap sequence (minimum: 3 taps within 2 seconds; the exact count and timing window SHALL be configurable via `silentActivationConfig`), THE Activation_Client SHALL initiate the Countdown_Window immediately and SHALL NOT produce any visible, audible, or vibration output that differs from normal button behaviour.
2. THE Activation_Client SHALL detect the power-button sequence entirely on-device with no network request at the moment of detection — the sequence detection SHALL function identically whether the device is online, on a degraded connection, or fully offline.
3. WHEN the power-button sequence is detected, THE Activation_Client SHALL initiate exactly one Countdown_Window regardless of how many additional button presses occur during the countdown — subsequent button presses during the Countdown_Window SHALL be treated as part of the Cancel_Gesture evaluation (Requirement 3) and SHALL NOT restart the Countdown_Window or create a second trigger.
4. IF the user has not configured a power-button sequence in `silentActivationConfig`, THEN the power-button trigger SHALL be disabled and THE Activation_Client SHALL NOT initiate a Countdown_Window in response to any button sequence.
5. THE Activation_Client SHALL distinguish the trigger sequence from accidental button patterns that occur when a device is dropped or carried in a pocket — a sequence of more than 8 taps within 2 seconds SHALL NOT activate the trigger (maximum tap threshold), and a sequence where any two consecutive taps are separated by more than 1 second SHALL NOT count as part of the same sequence.
6. WHEN the device screen is on and the RAKSHA PWA is in the foreground, AND WHEN the device screen is off, the power-button sequence SHALL be detectable — the trigger SHALL NOT require the RAKSHA app to be the focused window.

---

### Requirement 2: Bluetooth Earbud Triple-Click Trigger

**User Story:** As a RAKSHA user, I want to activate a silent SOS by triple-clicking my Bluetooth earbud's button, so that I can trigger help discreetly without touching my phone.

#### Acceptance Criteria

1. WHEN a paired Bluetooth earbud registers a triple-click event (three button presses within 1.5 seconds), THE Activation_Client SHALL initiate the Countdown_Window and SHALL NOT produce any response that differs from how the earbud normally behaves for other click patterns.
2. THE Activation_Client SHALL detect the triple-click entirely on-device using the available Bluetooth HID or media-session event API — no network request is made during detection.
3. IF no Bluetooth device is paired and connected at the time of the triple-click, OR IF the user has not enabled the Bluetooth earbud trigger in `silentActivationConfig`, THEN THE Activation_Client SHALL NOT initiate a Countdown_Window.
4. WHEN a triple-click is detected, THE Activation_Client SHALL initiate exactly one Countdown_Window — simultaneous button events from multiple paired earbuds within the same 1.5-second window SHALL result in at most one Countdown_Window.
5. THE Activation_Client SHALL treat a double-click and a single-click during the Countdown_Window as Cancel_Gesture candidates per Requirement 3, and SHALL NOT re-trigger or extend the Countdown_Window from earbud clicks that occur after it has started.

---

### Requirement 3: 10-Second Countdown and Cancel Window

**User Story:** As a RAKSHA user, I want a 10-second silent window after accidentally triggering SOS in which I can cancel it, so that dropped phones and pocket presses do not create false emergency alerts for my contacts.

#### Acceptance Criteria

1. WHEN any Trigger fires (power-button sequence, earbud triple-click, duress phrase, or duress PIN), THE Activation_Client SHALL enter the Countdown_Window of exactly 10 seconds duration before escalating to full SOS.
2. DURING the Countdown_Window, THE Activation_Client SHALL show no visible UI change that would reveal the pending SOS to a coercive observer — the countdown MAY use a subtle on-screen indicator that is only visible to the user (e.g., a minimally visible countdown or a haptic pulse series) if and only if it is not visible from a 1-metre distance at normal viewing angles.
3. WHEN the user performs the Cancel_Gesture (double-tap of the power button, or equivalent configured gesture) at any point during the Countdown_Window, THE Activation_Client SHALL cancel the countdown, SHALL NOT create an SOSSession document, and SHALL NOT contact any downstream service.
4. IF the Countdown_Window expires without a Cancel_Gesture, THE Activation_Client SHALL escalate by calling the `createSOSSession` Cloud_Function (or queuing the call offline per Requirement 8) with the trigger type, timestamp, and user identity.
5. THE Activation_Client SHALL accept only one cancellation attempt — if the Cancel_Gesture fires and the countdown has already escalated (i.e., the `createSOSSession` call already completed or was queued), THE Activation_Client SHALL NOT attempt to cancel the SOSSession at the client level and SHALL instead call the `cancelSOSSession` Cloud_Function.
6. WHEN the Countdown_Window is active and the device receives an incoming phone call or another app comes to the foreground, THE Activation_Client SHALL continue the countdown uninterrupted — the Countdown_Window SHALL NOT be cancelled by any OS event other than the explicit Cancel_Gesture.
7. THE Activation_Client SHALL record the exact UTC timestamp at which the Trigger fired and the Countdown_Window started, and SHALL include that timestamp in the SOSSession creation payload — this timestamp SHALL be a native `Date` and SHALL NOT be substituted with the server's receive time.

---

### Requirement 4: Duress PIN — Decoy Screen with Silent Background Trigger

**User Story:** As a RAKSHA user under coercion to unlock my phone, I want to enter a special PIN that opens a normal-looking screen while silently triggering an SOS, so that a coercive person cannot tell I have asked for help.

#### Acceptance Criteria

1. WHEN the user enters the Duress_PIN at the RAKSHA PIN entry screen (or any PIN entry surface where RAKSHA has injected its listener), THE Activation_Client SHALL immediately display the Decoy_Screen AND simultaneously initiate the Countdown_Window in the background — both actions SHALL occur within 200 milliseconds of PIN submission.
2. THE Decoy_Screen SHALL be visually indistinguishable from the state the app would show after an incorrect PIN entry or after the app has been freshly installed with no data — it SHALL NOT show any loading indicator, progress bar, or transition animation that does not also appear in the normal wrong-PIN or empty-app flow.
3. THE Decoy_Screen SHALL NOT be dismissable by back-button press, swipe gesture, or any other navigation event in a way that reveals the RAKSHA home screen to an observer — the user's normal RAKSHA content SHALL remain hidden for the duration of the Decoy_Screen session.
4. THE Duress_PIN SHALL be stored only as a salted hash in `silentActivationConfig.duressPin` — the plaintext PIN SHALL NOT be persisted anywhere on the device or in Firestore.
5. THE Duress_PIN SHALL be distinct from the user's normal RAKSHA PIN — IF the user attempts to configure a Duress_PIN that matches their normal PIN, THE Activation_Client SHALL reject the configuration with a validation error and SHALL NOT save the Duress_PIN.
6. IF the user enters neither the correct normal PIN nor the Duress_PIN (i.e., a wrong PIN), THE Activation_Client SHALL display the standard wrong-PIN error — the total time from PIN submission to first visible screen change SHALL be within 30 milliseconds of the median render time for the Duress_PIN path, measured across a minimum of 50 samples on the target device class; this bound covers the bcrypt verification cost, which must be made constant-time from an observer's perspective by padding the wrong-PIN path with a deliberate delay equal to the P95 bcrypt cost at the configured work factor — an observer watching the screen SHALL NOT be able to distinguish a wrong PIN from a Duress_PIN entry by response latency alone.
7. THE Countdown_Window initiated by Duress_PIN entry SHALL follow all rules in Requirement 3 — the Cancel_Gesture mechanism SHALL remain available to the user even while the Decoy_Screen is displayed, and the decoy UI SHALL not impede access to it.
8. WHEN the Duress_PIN trigger escalates to a full SOSSession (`active`), THE Decoy_Screen SHALL remain visible — the transition to an active SOSSession SHALL NOT cause any visible change on screen.

---

### Requirement 5: Duress Phrase Detection During a Live Call

**User Story:** As a RAKSHA user on the phone with a threatening person, I want RAKSHA to detect a pre-configured phrase I speak during the call and silently trigger SOS without interrupting or alerting the other party.

#### Acceptance Criteria

1. WHEN the device is on an active phone call and the microphone audio stream is accessible to the PWA (or a background service worker with microphone permission), THE Activation_Client SHALL continuously monitor for the user's configured `silentActivationConfig.duressPhrase` using the On_Device_Phrase_Matcher.
2. THE On_Device_Phrase_Matcher SHALL run entirely on-device — no audio data or phrase content SHALL be transmitted to any server during phrase matching, and phrase matching SHALL function identically whether the device is online or offline.
3. WHEN the On_Device_Phrase_Matcher detects the duress phrase with confidence above the configured sensitivity threshold, THE Activation_Client SHALL initiate the Countdown_Window and SHALL NOT alter the audio stream in any way that could be heard by the other party on the call (no click, beep, or volume change).
4. THE Activation_Client SHALL use fuzzy matching with a configurable tolerance for natural speech variation (e.g., different pacing, minor mispronunciation) — the match SHALL not require exact phoneme-for-phoneme reproduction of the configured phrase; the default tolerance SHALL correspond to roughly 80% phoneme match confidence. **[REQUIRES EMPIRICAL VALIDATION: this threshold is a placeholder. It has not been validated against a real on-device keyword-spotting library operating on a telephony-quality audio stream. The 80% value directly trades accidental-trigger risk (too low a threshold triggers on near-matches from a bystander) against failure-to-trigger risk in a real emergency (too high a threshold misses a stressed or accented pronunciation). The implementing engineer MUST measure the false-positive rate and false-negative rate for the chosen library at this threshold against a representative sample of speech, document the results, and adjust the default before this requirement is considered met. Until that measurement is complete, this criterion SHALL be treated as open.]**
5. THE Activation_Client SHALL NOT activate the Countdown_Window when the duress phrase is spoken by someone other than the device's primary user — IF voice biometric matching is available on the device, THE Activation_Client SHOULD use it to filter third-party speech; IF it is not available, phrase detection SHALL require a minimum of 3 consecutive phrase detections within 30 seconds before triggering, as a false-positive guard.
6. IF the user has not configured a Duress_Phrase in `silentActivationConfig.duressPhrase`, OR IF microphone permission has been denied, THE Activation_Client SHALL NOT activate the phrase listener and SHALL NOT request microphone permission at trigger time — permission SHALL be requested only at configuration time.
7. WHEN the active call ends, THE Activation_Client SHALL immediately suspend the On_Device_Phrase_Matcher to avoid background microphone activation after the call — if a Countdown_Window is in progress when the call ends, it SHALL continue to completion (the trigger already fired).

---

### Requirement 6: SOSSession Document Creation (Server-Side)

**User Story:** As the RAKSHA platform, I want a well-structured SOSSession document to be created in Firestore when a trigger escalates, so that downstream features (Guardian Network, evidence capture) have a stable, consistent record to react to.

#### Acceptance Criteria

1. WHEN the `createSOSSession` Cloud_Function is called with a valid authenticated user identity, trigger type, and client-recorded trigger timestamp, THE Cloud_Function SHALL create an SOSSession document in the SOSSession_Store with status `countdown` and SHALL return the `sessionId` to the caller.
2. THE SOSSession document SHALL contain at minimum: `sessionId`, `userId`, `triggerType` (one of `power_button`, `earbud`, `duress_phrase`, `duress_pin`), `triggeredAt` (native `Date` from the client payload — not the server receive time), `createdAt` (native `Date` from the server), `status` (initially `countdown`), `cancelledAt` (null), `activatedAt` (null), `location` (null or hashed GPS if provided), and `deviceInfo`.
3. ALL timestamp fields on an SOSSession document — including `triggeredAt`, `createdAt`, `cancelledAt`, `activatedAt` — SHALL be stored as JavaScript native `Date` objects; Firestore `Timestamp` objects SHALL NOT be used for any SOSSession timestamp field.
4. THE `createSOSSession` Cloud_Function SHALL be idempotent with respect to the client-recorded `triggeredAt` timestamp and `userId` — IF a call arrives with the same `userId` and `triggeredAt` (within a 5-second tolerance), THE Cloud_Function SHALL return the existing `sessionId` rather than creating a duplicate SOSSession.
5. WHEN the `createSOSSession` Cloud_Function creates an SOSSession document, THE Cloud_Function SHALL transition the status from `countdown` to `active` after 10 seconds have elapsed since `triggeredAt` (not since the server received the request), UNLESS a `cancelSOSSession` call arrives before that transition commits.
6. THE status transition from `countdown` to `active` SHALL be performed as a conditional Firestore transaction that writes `active` only if the status is still `countdown` at commit time — if the status has already changed to `cancelled` (a concurrent `cancelSOSSession` call won), the transition SHALL abort and log.
7. WHEN an SOSSession transitions to `active`, THE Cloud_Function SHALL update `activatedAt` to the current server time (native `Date`) in the same transaction as the status transition.
8. THE Cloud_Function SHALL NOT implement Guardian Network pinging or evidence capture trigger logic — it SHALL update the SOSSession status to `active` and leave Session_Hooks (the Firestore document state and any `onUpdate` trigger) for downstream features to consume.

---

### Requirement 7: SOSSession Cancellation

**User Story:** As a RAKSHA user who accidentally triggered SOS or who is now safe, I want to cancel an in-progress SOS within the countdown window, so that my emergency contacts are not falsely alerted.

#### Acceptance Criteria

1. WHEN the `cancelSOSSession` Cloud_Function is called with a valid `sessionId` and authenticated `userId` that matches the session's `userId`, THE Cloud_Function SHALL perform a conditional Firestore transaction that sets status to `cancelled` and records `cancelledAt` to the current server time (native `Date`) only if the status is still `countdown` at commit time.
2. IF the SOSSession status is already `active` at commit time (the 10-second countdown has elapsed and escalation committed first), THEN THE `cancelSOSSession` Cloud_Function SHALL return a response indicating the session has already escalated and SHALL NOT modify the SOSSession document — the caller must be informed that cancellation was not possible.
3. IF the SOSSession status is already `cancelled`, THE `cancelSOSSession` Cloud_Function SHALL return an idempotent success response — calling cancel on an already-cancelled session SHALL NOT return an error.
4. IF the caller's `userId` does not match the SOSSession's `userId`, THE Cloud_Function SHALL reject the request with a permission error and SHALL NOT modify the document.
5. WHEN an SOSSession is cancelled, THE Activation_Client SHALL receive an observable confirmation (via the Cloud_Function response or via a Firestore listener) within 3 seconds of the Cancel_Gesture — the user SHALL NOT be left in uncertainty about whether the cancellation succeeded.
6. A cancelled SOSSession SHALL be a terminal state — no component SHALL transition a `cancelled` session back to `countdown` or to `active`.

---

### Requirement 8: Offline Trigger Queueing and Sync

**User Story:** As a RAKSHA user in a dangerous situation with no connectivity, I want my SOS trigger to be reliably queued and sent as soon as connectivity is restored, so that poor signal does not prevent me from getting help.

#### Acceptance Criteria

1. WHEN any Trigger escalates (Countdown_Window expires without cancellation) and the device has no network connectivity, THE Activation_Client SHALL persist the SOSSession creation payload — including trigger type, `triggeredAt`, and user identity — to the Offline_Queue on the device before returning to the user-facing UI.
2. THE Offline_Queue SHALL be durable across app restarts — if the device is turned off and back on while an unsynced SOSSession payload is queued, that payload SHALL be present in the queue when the app next starts.
3. WHEN network connectivity is restored, THE Activation_Client SHALL dequeue pending SOSSession creation payloads and call `createSOSSession` for each, in the order they were enqueued — dequeue attempts SHALL begin within 5 seconds of connectivity being detected.
4. WHEN a queued SOSSession is synced after connectivity is restored, THE `createSOSSession` Cloud_Function SHALL use the original client-recorded `triggeredAt` timestamp from the payload, not the time the sync call arrived — the SOSSession document SHALL accurately reflect when the trigger actually fired.
5. IF a queued SOSSession payload fails to sync after 3 attempts (e.g., repeated network failures), THE Activation_Client SHALL retain it in the Offline_Queue and SHALL retry with exponential backoff — the payload SHALL NOT be discarded silently.
6. THE Offline_Queue SHALL hold at most 10 pending SOSSession payloads — IF the queue is full when a new trigger fires, the oldest unsynced payload SHALL be dropped and THE Activation_Client SHALL log the drop; this limit exists to prevent unbounded storage use, not to compromise safety for the current trigger.
7. WHEN the Activation_Client is offline and a Cancel_Gesture fires during the Countdown_Window (before escalation), THE Activation_Client SHALL discard the trigger payload and SHALL NOT enqueue any SOSSession creation payload — a cancelled countdown is not queued regardless of connectivity state.
8. WHEN the Activation_Client dequeues a payload and calls `createSOSSession`, THE Activation_Client SHALL include the current wall-clock time alongside the original `triggeredAt` in the request — this allows the server to compute the sync delay and apply the `LATE_SYNC` annotation (Requirement 12.4) without the server needing to infer the delay from its own receive time alone.

---

### Requirement 9: Session Hook Interface for Downstream Features

**User Story:** As a RAKSHA platform engineer, I want the SOSSession document to serve as a stable, well-defined integration point that Guardian Network and evidence capture can react to, so that those features can be built independently without coupling to the trigger detection mechanism.

#### Acceptance Criteria

1. WHEN an SOSSession transitions to `active`, THE Activation_Server SHALL ensure that the SOSSession document in Firestore reflects the `active` status atomically with `activatedAt` being set — no document state SHALL be observable where `status` is `active` but `activatedAt` is null.
2. THE SOSSession_Store SHALL support Firestore `onUpdate` triggers — downstream Cloud Functions SHALL be able to react to SOSSession status changes by listening to Firestore document update events on `/sosSessions/{sessionId}` without any code changes to the Activation_Server.
3. THE `createSOSSession` and `cancelSOSSession` Cloud_Functions SHALL NOT contain any calls to Guardian Network, evidence capture, or any other downstream service — those integrations belong in separate Cloud Functions triggered by the SOSSession Firestore document state.
4. THE SOSSession document structure defined in Requirement 6.2 SHALL be treated as a stable interface — no field SHALL be renamed or removed without a versioned migration; new fields MAY be added.
5. THE SOSSession_Store Firestore security rules SHALL allow the owning user (`userId`) to read their own session documents and SHALL deny read access to all other users, including RAKSHA platform operators — downstream Cloud Functions access the SOSSession via Admin SDK and are not subject to these client-facing rules.
6. THE SOSSession_Store Firestore security rules SHALL deny ALL client write access to SOSSession documents after initial creation — the `createSOSSession` and `cancelSOSSession` Cloud_Functions own all post-creation writes via Admin SDK.

---

### Requirement 10: Trigger Configuration and Validation

**User Story:** As a RAKSHA user, I want to configure my trigger preferences before an emergency, so that the activation method works reliably for me and does not conflict with other apps or gestures.

#### Acceptance Criteria

1. WHEN a user saves their silent activation configuration, THE Activation_Client SHALL validate that: at least one trigger type is enabled; the Duress_PIN (if set) is between 6 and 8 digits, is numeric, and does not match the user's normal RAKSHA PIN; the Duress_Phrase (if set) is between 3 and 50 characters and contains at least two words; the power-button tap count (if configured) is between 3 and 7 taps. [Note: minimum raised from 4 to 6 digits — see security analysis in design.md §PIN Brute-Force Analysis.]
2. THE Activation_Client SHALL store the Duress_PIN only as a salted hash using bcrypt with cost = 10 — the plaintext PIN SHALL be zeroed from memory immediately after hashing and SHALL NOT appear in any log, error message, or network request. The hash SHALL be stored in `silentActivationConfig.duressPin` in Firestore. [Note: cost is fixed at 10, not 8 — see design.md §PIN Brute-Force Analysis and §Decision 3 amendment for the UX mitigation that removes the constant-time penalty from the normal login path.]
3. WHEN the user updates their Duress_Phrase, THE Activation_Client SHALL update the On_Device_Phrase_Matcher's reference template on the same device within 500 milliseconds — the old phrase SHALL cease to be a valid trigger immediately.
4. THE `silentActivationConfig` object SHALL be stored as a sub-document on the User document in Firestore — client-side Firestore security rules SHALL permit the owning user to read and write their own `silentActivationConfig` and SHALL deny access to all other users.
5. THE Activation_Client SHALL allow the user to test each configured trigger in a dedicated "test mode" that runs the full detection path (including Countdown_Window) but calls a `testTrigger` endpoint instead of `createSOSSession`, so that no real SOSSession is created during configuration testing.
6. IF the user disables all trigger types simultaneously, THE Activation_Client SHALL display a warning that the feature will be fully inactive and SHALL require explicit confirmation before saving — the user SHALL NOT inadvertently disable all their triggers without acknowledgement.

---

### Requirement 11: Privacy, Security, and Observability Constraints

**User Story:** As a RAKSHA user, I want the activation feature to leave no traces that could be discovered by an abuser examining my phone, and as a RAKSHA platform engineer I want the system to be auditable server-side without exposing sensitive details to operators.

#### Acceptance Criteria

1. THE Activation_Client SHALL NOT store the duress phrase in plaintext in any location accessible to another app, the OS log, crash reporters, or developer tools — the phrase template used by the On_Device_Phrase_Matcher SHALL be stored in encrypted form in the app's private storage, keyed to the user's authenticated identity.
2. THE Activation_Client SHALL NOT produce any network traffic at the moment of trigger detection that would be distinguishable from normal app activity (e.g., no abrupt burst of requests that correlates with the trigger) — the Countdown_Window specifically SHALL produce no outbound requests until escalation.
3. WHEN an SOSSession is created, THE Cloud_Function SHALL record a server-side audit log entry containing: `sessionId`, `userId` (hashed), `triggerType`, `triggeredAt`, and `createdAt` — raw GPS coordinates or exact `triggeredAt` timestamps SHALL NOT appear in application logs.
4. THE SOSSession document SHALL NOT be readable by RAKSHA platform operators through the Firebase Console without explicit `admin` role assignment — Firestore security rules SHALL deny reads to all users other than the owning user; Admin SDK access by Cloud Functions is not subject to these rules.
5. THE Activation_Client SHALL clear all in-memory countdown state, trigger timestamps, and duress phrase match results when the user logs out — no sensitive activation state SHALL persist in memory across authentication sessions.
6. THE Activation_Server SHALL rate-limit calls to `createSOSSession` to a maximum of 5 sessions per user per rolling 10-minute window — if this limit is exceeded, THE Cloud_Function SHALL reject further calls with a rate-limit error for the remainder of the window and SHALL log the event, but SHALL NOT alert the user in a way that is visible on-screen. This rate-limit applies to SOSSession creation only; it does NOT protect against offline brute-force of an extracted `duressPin` hash — that protection comes from hash cost and minimum PIN length (Req 10.1–10.2).
7. THE `duressPin` field in `silentActivationConfig` SHALL NOT be readable by any component other than the on-device PIN verification path — specifically, no Cloud Function, no API endpoint, and no client code path other than the PIN entry handler SHALL read or transmit the hash value. If a future design requires server-side PIN verification (to eliminate the offline-crack vector), the hash SHALL be migrated to a server-only Firestore sub-collection with deny-all client read rules before that endpoint is built. [Phase 1 retains client-side verification; this criterion documents the security boundary and the migration precondition for Phase 2.]

---

### Requirement 12: Timestamp Consistency

**User Story:** As a RAKSHA platform engineer, I want all SOSSession timestamps to use native Date objects consistently with the rest of the RAKSHA platform, so that deserialization never fails and the codebase follows one convention.

#### Acceptance Criteria

1. THE Activation_Server SHALL store all SOSSession timestamp fields — `triggeredAt`, `createdAt`, `cancelledAt`, `activatedAt` — as JavaScript native `Date` objects; Firestore `Timestamp` objects SHALL NOT be used for any SOSSession timestamp field.
2. WHEN any Cloud_Function reads an SOSSession document from Firestore, THE Cloud_Function SHALL deserialize timestamp fields using the same `assertDate` / `assertDateOrNull` guard used by the Evidence Trail system — if a field fails the `instanceof Date` check, THE Cloud_Function SHALL abort the operation and log the field name and actual type.
3. THE Activation_Client SHALL create `triggeredAt` using `new Date()` at the exact moment the Trigger fires (not when escalation occurs, not when the network call is made) — this timestamp SHALL be passed through the Offline_Queue payload without modification.
4. THE Activation_Server SHALL NOT substitute the server receive time for the client-provided `triggeredAt` — the server SHALL validate that `triggeredAt` is a valid Date and is within a reasonable window (no more than 72 hours in the past, not in the future) and SHALL reject payloads outside that window with a descriptive error. WHEN the gap between `triggeredAt` and the server receive time exceeds 60 minutes, THE Cloud_Function SHALL set a `syncDelayMinutes` field on the SOSSession document recording the rounded gap, and SHALL record a `LATE_SYNC` flag in its audit log entry — the session SHALL be created and processed normally regardless of the gap; the flag exists for platform monitoring, not for suppression. A gap of up to 72 hours is accepted as legitimate offline queuing (Requirement 8). The 72-hour window is intentionally asymmetric: a future `triggeredAt` (even by 1 second) is rejected because it cannot represent a real on-device event, while a past `triggeredAt` can represent legitimate offline operation.
