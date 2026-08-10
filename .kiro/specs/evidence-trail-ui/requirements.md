# Requirements Document — Evidence Trail UI

## Introduction

The Evidence Trail UI provides frontend screens for the fully implemented Evidence Trail backend. The backend includes `captureEvidence`, `generateLegalExport`, `serveEvidenceFile`, access control functions, `retriggerProcessing`, and `reportUploadFailure`, all tested with 188 passing unit+integration tests. This UI exposes that capability to users through three primary screens:

1. **Evidence Capture** — file picker, client-side hash, upload with progress
2. **Evidence Timeline** — list all evidence items for an incident with chain-of-custody status
3. **Legal Export** — generate and download court-ready PDF packages

The UI follows RAKSHA's existing design language: light/white surfaces, native Date handling (no Firestore Timestamp objects in client state), real Firebase emulator calls (no mocks), and consistent styling matching HomeScreen/CountdownScreen.

---

## Glossary

- **Evidence Item**: A single piece of evidence (photo, video, audio, screenshot, document) captured and uploaded via the Evidence Trail system.
- **Incident**: A harassment or safety incident; evidence items are scoped to a specific incident via `incidentId`.
- **Chain of Custody**: The immutable audit log of actions taken on an evidence item (uploaded, viewed, shared, exported, status changes).
- **Legal Export**: A court-ready PDF package containing all evidence files for an incident, metadata, chain-of-custody logs, and integrity verification.
- **SHA-256 Hash**: Client-side cryptographic hash computed over raw file bytes before upload, verified server-side for integrity.
- **Evidence Status**: One of: `uploading`, `processing`, `available`, `expired`, `legal_hold`, `failed`, `integrity_failed`, `encryption_failed`.
- **SOS Active Session**: An active emergency session initiated via a trigger (shake, duress PIN, etc.), to which evidence can be attached.

---

## Requirements

### Requirement 1: Evidence Capture Screen

**User Story:** As a RAKSHA user, I want to attach photo/video/audio evidence to an active SOS incident from a simple file picker screen, so that I can document what's happening during an emergency.

#### Acceptance Criteria

1. THE Evidence Capture screen SHALL be accessible at route `/evidence/capture`.
2. WHEN no SOS session is active, THE screen SHALL display a message directing the user to start an SOS session first and SHALL NOT display a file picker.
3. WHEN an active SOS session exists, THE screen SHALL display a file picker (`<input type="file" />`) with the `capture` attribute set to enable direct camera/microphone access on mobile devices.
4. THE file picker SHALL accept files with MIME types corresponding to photo, video, and audio (e.g., `image/*`, `video/*`, `audio/*`).
5. WHEN a user selects a file, THE screen SHALL compute the SHA-256 hash client-side using the existing `computeSHA256` utility from `functions/src/client/computeSHA256.ts` (reused on the client).
6. AFTER hash computation completes, THE screen SHALL call the existing `captureEvidence` orchestrator from `functions/src/client/captureEvidence.ts` with:
   - File data
   - `userId` from Firebase Auth
   - `deviceInfo` from `navigator.userAgent`
   - `incidentId` from the active SOS session
   - `capturedAt` as `new Date()` (client-local timestamp)
   - `gpsAtCapture` obtained via the existing `getCurrentHashedLocation()` from `hooks/useGeolocation.ts`, with graceful null fallback on denial/timeout
7. WHILE the upload is in progress, THE screen SHALL display a progress indicator and disable the file picker.
8. IF the upload succeeds, THE screen SHALL display a success message for 2 seconds, then navigate back to the SOS Active screen (or a dedicated Evidence Timeline screen if available).
9. IF the upload fails, THE screen SHALL display the error message returned by `captureEvidence` and allow the user to retry.
10. THE screen SHALL use native `Date` objects for all timestamps and SHALL NOT serialize Firestore `Timestamp` objects into client state.

---

### Requirement 2: Evidence List/Timeline Screen

**User Story:** As a RAKSHA user, I want to see a chronological list of all evidence I've captured for a specific incident, so that I can review what I've documented and verify the chain of custody.

#### Acceptance Criteria

1. THE Evidence Timeline screen SHALL be accessible at route `/incidents/:incidentId/evidence`.
2. THE screen SHALL query the Firestore `evidence` collection for all documents where `incidentId` matches the route parameter and `userId` matches the authenticated user's `uid`.
3. THE screen SHALL display each evidence item with:
   - Type icon (📷 for photo, 🎥 for video, 🎤 for audio, etc.)
   - `originalFilename`
   - `capturedAt` timestamp formatted as a human-readable date/time (e.g., "Jan 15, 2026 3:42 PM")
   - Current `status` as a colored chip (green for `available`, amber for `processing`/`uploading`, red for terminal failures)
   - Chain-of-custody summary: count of entries (e.g., "3 actions recorded")
4. WHEN a user taps an evidence item, THE screen SHALL call `serveEvidenceFile` to display the decrypted file in a modal overlay.
5. IF the evidence item status is `available`, THE screen SHALL call the `serveEvidenceFile` Cloud Function, which returns base64-encoded decrypted bytes and mimeType.
6. THE screen SHALL convert the base64 response to a Blob, create an in-memory object URL (`URL.createObjectURL(blob)`), and display it in an `<img>`, `<video>`, or `<audio>` element within a modal.
7. WHEN the modal is closed, THE screen SHALL immediately revoke the object URL (`URL.revokeObjectURL()`) to release the in-memory blob.
8. THE screen SHALL NOT cache decrypted file contents in localStorage, IndexedDB, or any persistent storage mechanism — decrypted content SHALL exist only in memory during the viewing session.
9. THE screen SHALL NOT attempt to decrypt evidence files client-side — all decryption SHALL be performed server-side via `serveEvidenceFile`.
10. THE in-memory object URL SHALL be ephemeral and SHALL NOT be reused across multiple view requests — each "view" action SHALL call `serveEvidenceFile` fresh and create a new object URL.
7. THE screen SHALL display a loading state while querying Firestore and a "No evidence captured yet" message if the result set is empty.
8. WHEN the viewing modal is closed, THE screen SHALL revoke all object URLs created during the session to prevent memory leaks.
9. THE screen SHALL use native `Date` objects when reading `capturedAt` and other timestamp fields from Firestore and SHALL NOT store Firestore `Timestamp` objects in component state.

**Security Constraint**: Decrypted evidence SHALL NOT be cached persistently. The `serveEvidenceFile` response (base64-encoded decrypted bytes) is converted to an in-memory Blob and displayed via `URL.createObjectURL()`. The object URL is revoked immediately when the modal closes. No decrypted content persists in localStorage, IndexedDB, or browser cache beyond the viewing session. This preserves the access-control guarantees of the Evidence Trail backend: if a user's access is revoked, they cannot view evidence again, even if they previously viewed it.

---

### Requirement 3: Legal Export Screen

**User Story:** As a RAKSHA user, I want to generate a court-ready PDF export of all evidence for an incident, so that I can submit it to law enforcement or legal proceedings with full chain-of-custody proof.

#### Acceptance Criteria

1. THE Legal Export screen SHALL be accessible at route `/incidents/:incidentId/export`.
2. THE screen SHALL display a "Generate Legal Export" button.
3. WHEN the user presses the button, THE screen SHALL call the `generateLegalExport` Cloud Function (via `httpsCallable`) with the `incidentId` from the route parameter.
4. WHILE the export is being generated, THE screen SHALL display a loading spinner and a message indicating "Generating export… this may take a few seconds."
5. IF the export succeeds, THE screen SHALL display a download link or automatically trigger a browser download of the returned PDF file.
6. IF the export fails because any evidence file is inaccessible (per the backend's fail-whole design), THE screen SHALL display a clear error message explaining which file(s) could not be accessed.
7. IF the export fails because no evidence exists for the incident, THE screen SHALL display a message "No evidence available for this incident."
8. THE screen SHALL NOT display any decrypted file contents — the PDF is generated server-side and returned as a complete document.
9. THE screen SHALL use native `Date` objects for any timestamp display (e.g., export generation timestamp) and SHALL NOT serialize Firestore `Timestamp` objects into component state.

---

### Requirement 4: Integration with Existing SOS Flow

**User Story:** As a RAKSHA user, I want a clear path to add evidence during an active SOS session, so that I don't have to manually navigate through multiple screens.

#### Acceptance Criteria

1. WHEN an SOS session is active (status: 'active' in CountdownScreen or similar), THE SOS Active screen SHALL display a button "Add evidence to this incident" that navigates to `/evidence/capture`.
2. THE Evidence Capture screen SHALL read the active incident ID from the SOS session state (via React context, location.state, or localStorage, whichever is used by the existing SOS flow).
3. IF no active SOS session is found, THE Evidence Capture screen SHALL display a message "Start an SOS session first" and provide a link back to the Home screen.
4. THE existing SOS flow SHALL NOT be modified beyond adding the "Add evidence" button — all countdown logic, guardian pings, and session management remain unchanged.

---

### Requirement 5: Design Language Consistency

**User Story:** As a RAKSHA user, I want the evidence screens to look and feel like the rest of the app, so that the experience is cohesive.

#### Acceptance Criteria

1. ALL evidence screens SHALL use the existing RAKSHA design tokens from `index.css`: `--surface`, `--text`, `--text-muted`, `--accent-red`, `--accent-green`, `--accent-amber`, `--radius`, `--shadow`, etc.
2. ALL evidence screens SHALL use the existing layout classes: `.screen`, `.screen-centered`, `.card`, `.btn`, `.btn-primary`, `.btn-ghost`, `.banner`, `.chip`, `.nav-bar`, etc.
3. ALL file picker inputs SHALL have the `capture` attribute set (for mobile camera/mic access) and follow the existing form input styling.
4. ALL loading states SHALL use the existing `.spinner` component.
5. ALL error states SHALL use the existing `.banner.banner-error` component with clear, actionable messages.
6. ALL success states SHALL use the existing `.banner.banner-info` component.
7. ALL navigation elements SHALL use React Router's `<Link>` or `useNavigate()` — no direct `window.location` manipulation.

---

### Requirement 6: Real Firebase Emulator Calls (No Mocks)

**User Story:** As a RAKSHA platform engineer, I want the evidence UI to call the real Firebase Emulator in development, so that I can verify end-to-end behavior against the actual backend.

#### Acceptance Criteria

1. ALL Evidence UI screens SHALL call Firebase Firestore, Firebase Storage, and Firebase Functions via the existing `firebase.ts` SDK instances (`db`, `storage`, `fns`).
2. WHEN `VITE_USE_EMULATOR=true`, ALL Firebase calls SHALL route to the emulator (already wired in `firebase.ts`).
3. THE UI SHALL NOT mock Firestore queries, Storage uploads, or Cloud Function calls — all calls SHALL be real SDK operations.
4. ALL error handling SHALL surface real Firebase error codes (e.g., `permission-denied`, `not-found`, `unauthenticated`) to the user in development mode (`import.meta.env.VITE_USE_EMULATOR === 'true'`).
5. THE UI SHALL NOT introduce any custom mock/stub layers — all testing against the Evidence Trail backend SHALL be via the Firebase Emulator Suite.

---

### Requirement 7: Native Date Handling (No Firestore Timestamp in State)

**User Story:** As a RAKSHA platform engineer, I want all timestamp fields to use JavaScript's native Date class, so that serialization is consistent and SDK version-agnostic.

#### Acceptance Criteria

1. WHEN reading evidence documents from Firestore, ALL timestamp fields (`createdAt`, `updatedAt`, `capturedAt`, `retentionExpiresAt`, `ChainOfCustodyEntry.timestamp`) SHALL be validated as `instanceof Date`.
2. IF a timestamp field deserializes as a Firestore `Timestamp` object, THE UI SHALL call `.toDate()` immediately at the deserialization boundary and use only the resulting `Date` in component state.
3. THE UI SHALL NOT store Firestore `Timestamp` objects in React state, localStorage, or component props.
4. THE UI SHALL use `new Date()` for all client-generated timestamps (e.g., `capturedAt`).
5. ALL timestamp display logic (formatting as "Jan 15, 2026 3:42 PM") SHALL operate on native `Date` objects using `.toLocaleDateString()` and `.toLocaleTimeString()`.

---

## Non-Functional Requirements

1. **Performance**: Evidence list queries SHALL use Firestore indexes (composite index on `incidentId` + `userId` if needed) to avoid full collection scans.
2. **Accessibility**: All interactive elements (buttons, links, file inputs) SHALL have visible focus states and keyboard navigation support.
3. **Responsiveness**: All screens SHALL be mobile-first and work on viewport widths down to 320px.
4. **Security**: All evidence file access SHALL go through `serveEvidenceFile` — the UI SHALL NOT attempt to read Firebase Storage objects directly.
5. **Error Handling**: All Firebase operations (Firestore queries, Storage uploads, Cloud Function calls) SHALL be wrapped in try/catch blocks with user-facing error messages.

---

## Out of Scope (Not in This Session)

1. **Edit/Delete Evidence**: Users cannot edit or delete evidence items from the UI (immutable by design).
2. **Evidence Filtering**: No date-range or status filters on the Evidence Timeline (future enhancement).
3. **Chain-of-Custody Detail View**: Full custody log display is deferred to Legal Export PDF — the Timeline shows only a summary.
4. **Real-Time Updates**: The Timeline does not use Firestore realtime listeners — it's a static query on mount.
5. **Evidence Sharing UI**: Granting/revoking access to contacts is not exposed in the UI (future enhancement).
6. **Signed Time-Limited URLs**: `serveEvidenceFile` currently returns raw base64-encoded decrypted bytes in the Cloud Function response payload. The architecturally correct implementation would have the function write decrypted bytes to a temporary Storage path, generate a signed URL valid for ~5 minutes, and return the URL — so the access window is enforced by URL expiry on the server side rather than relying on client-side revoking of an object URL. That backend change is out of scope for this session. The frontend enforces in-memory-only access (Req 2.6–2.10) as the mitigating control. The backend should be refactored to signed URLs in a future session.

---

## Acceptance Testing Checklist

- [ ] Evidence Capture screen accessible at `/evidence/capture`
- [ ] File picker only visible when SOS session is active
- [ ] SHA-256 hash computed client-side before upload
- [ ] `captureEvidence` called with correct parameters (userId, incidentId, deviceInfo, gpsAtCapture)
- [ ] Upload progress indicator displayed
- [ ] Success/failure messages displayed appropriately
- [ ] Evidence Timeline accessible at `/incidents/:incidentId/evidence`
- [ ] Timeline displays all evidence items for the incident with correct metadata
- [ ] Tapping an item calls `serveEvidenceFile` and displays the decrypted file
- [ ] Legal Export accessible at `/incidents/:incidentId/export`
- [ ] "Generate Legal Export" button calls `generateLegalExport`
- [ ] PDF download link appears on success
- [ ] Fail-whole error message displayed if any file is inaccessible
- [ ] "Add evidence" button visible during active SOS session
- [ ] All screens use existing design tokens and layout classes
- [ ] All Firebase calls route to emulator when `VITE_USE_EMULATOR=true`
- [ ] All timestamps handled as native `Date` objects
- [ ] No Firestore `Timestamp` objects in React state

