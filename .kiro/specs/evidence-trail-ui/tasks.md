# Implementation Tasks — Evidence Trail UI

## Overview

Three React screens + routing + shared utilities. The Evidence Trail backend is fully implemented and tested; this is pure frontend wiring. All tasks reference the Design document for details (design.md §N references are shown in task descriptions).

**Estimated scope**: 8–12 hours for a developer familiar with the RAKSHA codebase. The bulk is in Task 4 (Capture screen state machine + adapters).

---

## Task Breakdown

### Task 1: Copy Evidence Client Libraries (45 min)

**Goal**: Bring the backend client code into the frontend package to avoid cross-package Vite import complexity.

#### 1.1 Create directory structure
```
client/app/src/lib/evidence/
```

#### 1.2 Copy three files from `functions/src/client/` → `client/app/src/lib/evidence/`
- `captureEvidence.ts`
- `validateFile.ts`
- `checkIdempotency.ts`

#### 1.3 Strip `.js` extensions from relative imports
All three files use Node ESM `.js` extensions (`./validateFile.js`, `./checkIdempotency.js`). Change these to plain `.ts` imports or extensionless:
```typescript
// Before:
import { validateFile } from './validateFile.js'
// After:
import { validateFile } from './validateFile'
```

#### 1.4 Re-export types
Create `client/app/src/lib/evidence/index.ts`:
```typescript
export * from './captureEvidence'
export * from './validateFile'
export * from './checkIdempotency'
```

#### 1.5 Verify build
Run `npm run build` (or `pnpm build`) in the `client/app/` directory. Ensure no import errors.

**Acceptance**: `client/app/src/lib/evidence/` contains all three files, imports are clean, build passes.

---

### Task 2: Shared Utilities (1 hour)

**Goal**: Timestamp handling, adapters, and client-side types.

#### 2.1 `src/utils/evidenceTimestamp.ts`
Implement three functions per design.md §Shared Utilities:
- `toDate(value: unknown): Date | null` — converts Firestore Timestamp, native Date, or ISO string to Date
- `requireDate(value: unknown, fieldName: string): Date` — like toDate but throws if null
- `formatTimestamp(date: Date): string` — human-readable format using `toLocaleDateString`

#### 2.2 `src/utils/evidenceTypes.ts`
Define `EvidenceStatus` type and `EvidenceItem` interface (subset of `EvidenceDocument` with only UI-relevant fields, all timestamps as native Date).

#### 2.3 `src/utils/evidenceAdapters.ts`
Implement three adapter factories per design.md §Shared Utilities:
- `makeFirestoreAdapter()` — wraps `db` from `firebase.ts`
- `makeStorageAdapter(onProgress?: UploadProgressCallback)` — wraps `storage` with `uploadBytesResumable`
- `makeFunctionsAdapter()` — wraps `fns` with `httpsCallable`

All adapters implement the interfaces from `captureEvidence.ts` (`FirestoreAdapter`, `StorageAdapter`, `FunctionsAdapter`).

#### 2.4 Unit tests (optional but recommended)
- `evidenceTimestamp.test.ts`: test `toDate` with Firestore Timestamp mock, native Date, ISO string, null
- `evidenceTypes.test.ts`: type-only file, no runtime tests needed

**Acceptance**: Three new utility files in `src/utils/`, all imports resolve, adapters match the interface signatures.

---

### Task 3: Firestore Index (10 min)

**Goal**: Add composite index for the Evidence Timeline query.

#### 3.1 Create or update `firestore.indexes.json`
Location: workspace root (same level as `firebase.json`).

Add the index per design.md §Firestore Index Requirements:
```json
{
  "indexes": [
    {
      "collectionGroup": "evidence",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "incidentId", "order": "ASCENDING" },
        { "fieldPath": "userId",     "order": "ASCENDING" },
        { "fieldPath": "metadata.capturedAt", "order": "DESCENDING" }
      ]
    }
  ]
}
```

If the file already exists with other indexes, append this to the `indexes` array.

#### 3.2 Deploy index (emulator auto-creates it; production needs deploy)
Emulator mode: the index is created automatically on first query.  
Production: run `firebase deploy --only firestore:indexes`.

**Acceptance**: `firestore.indexes.json` exists, contains the evidence index. Timeline query succeeds in emulator without index-required error.

---

### Task 4: Evidence Capture Screen (3 hours)

**Goal**: File picker → hash → upload orchestrator → progress → navigate.

#### 4.1 Create `src/screens/EvidenceCaptureScreen.tsx`
Scaffold with route structure:
- Read `incidentId` from `useSearchParams()`
- If no incidentId: show "No active SOS session" message + link to `/home`
- If incidentId: show file picker + phase state

#### 4.2 State machine
Single `useState<CapturePhase>`:
```typescript
type CapturePhase =
  | { kind: 'idle' }
  | { kind: 'hashing' }
  | { kind: 'uploading'; progressPct: number }
  | { kind: 'success' }
  | { kind: 'error'; message: string }
```

#### 4.3 File picker input
```tsx
<input
  type="file"
  accept="image/*,video/*,audio/*"
  capture="environment"
  onChange={handleFileSelect}
  disabled={phase.kind !== 'idle'}
/>
```

#### 4.4 `handleFileSelect` implementation
- Generate `evidenceId` = `crypto.randomUUID()` (stored in `useRef`)
- Set phase to `{ kind: 'hashing' }`
- Call `getCurrentHashedLocation()` (from `hooks/useGeolocation.ts`)
- Create adapters: `makeFirestoreAdapter()`, `makeStorageAdapter(onProgress)`, `makeFunctionsAdapter()`
- Set phase to `{ kind: 'uploading', progressPct: 0 }`
- Call `captureEvidence(evidenceId, file, userId, metadata, ...adapters, computeSHA256WebCrypto)`
- On success: phase `{ kind: 'success' }`, navigate to `/incidents/${incidentId}/evidence` after 2s
- On error: phase `{ kind: 'error', message }`

#### 4.5 `computeSHA256WebCrypto` helper
Inline function matching the signature expected by `captureEvidence`:
```typescript
async function computeSHA256WebCrypto(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
```

#### 4.6 Progress rendering
```tsx
{phase.kind === 'uploading' && (
  <div className="progress-bar">
    <div className="progress-fill" style={{ width: `${phase.progressPct}%` }} />
  </div>
)}
```

Add basic progress bar CSS to `index.css` or inline styles.

#### 4.7 Banner display
Success: `.banner.banner-info`  
Error: `.banner.banner-error`

**Acceptance**: File picker works, upload shows progress, navigates to Timeline on success, shows error on failure. Tested in emulator with real Firestore/Storage/Functions calls.

---

### Task 5: Evidence Timeline Screen (2.5 hours)

**Goal**: List evidence items, tap to view via `serveEvidenceFile`, modal with in-memory object URLs.

#### 5.1 Create `src/screens/EvidenceTimelineScreen.tsx`
Scaffold with route structure:
- Read `incidentId` from `useParams()`
- Two independent state machines: `TimelineState`, `ViewState`

#### 5.2 Firestore query on mount
```typescript
const q = query(
  collection(db, 'evidence'),
  where('incidentId', '==', incidentId),
  where('userId', '==', uid),
  orderBy('metadata.capturedAt', 'desc')
)
const snap = await getDocs(q)
```

Map each doc through `deserializeEvidenceItem` (helper function) to produce `EvidenceItem[]`.

#### 5.3 `deserializeEvidenceItem` helper
Extracts UI-relevant fields from Firestore `DocumentData`, converts timestamps via `requireDate`:
```typescript
function deserializeEvidenceItem(raw: DocumentData): EvidenceItem {
  const metadata = raw.metadata as Record<string, unknown>
  return {
    evidenceId:          raw.evidenceId as string,
    incidentId:          raw.incidentId as string,
    type:                raw.type as EvidenceItem['type'],
    originalFilename:    raw.originalFilename as string,
    mimeType:            raw.mimeType as string,
    sizeBytes:           raw.sizeBytes as number,
    status:              raw.status as EvidenceStatus,
    capturedAt:          requireDate(metadata?.capturedAt, 'metadata.capturedAt'),
    retentionExpiresAt:  toDate(raw.retentionExpiresAt),
    custodyCount:        Array.isArray(raw.chainOfCustody) ? raw.chainOfCustody.length : 0,
  }
}
```

#### 5.4 List rendering
For each item, render a card with:
- Type icon (from `TYPE_ICONS` map: 📷/🎥/🎤/🖼️/📄)
- `originalFilename`
- `formatTimestamp(capturedAt)`
- Status chip (colored by status — green/amber/red)
- Custody summary: `{custodyCount} actions recorded`
- `onClick` → open view modal

#### 5.5 View modal logic
When user taps an item:
1. Set `ViewState: { kind: 'loading', evidenceId }`
2. Call `httpsCallable(fns, 'serveEvidenceFile')({ evidenceId })`
3. On success: `{ data: string (base64), mimeType: string }`
   - Convert base64 → Uint8Array → Blob
   - `objectUrl = URL.createObjectURL(blob)`
   - Set `ViewState: { kind: 'viewing', evidenceId, objectUrl, mimeType }`
4. On error: `ViewState: { kind: 'error', evidenceId, message }`

#### 5.6 Modal rendering by MIME type
```tsx
{mimeType.startsWith('image/') && <img src={objectUrl} />}
{mimeType.startsWith('video/') && <video src={objectUrl} controls />}
{mimeType.startsWith('audio/') && <audio src={objectUrl} controls />}
{mimeType === 'application/pdf' && <iframe src={objectUrl} />}
{/* fallback: download link */}
<a href={objectUrl} download={filename}>Download</a>
```

#### 5.7 Modal close + revoke
```typescript
function closeModal() {
  if (viewState.kind === 'viewing') {
    URL.revokeObjectURL(viewState.objectUrl)
  }
  setViewState({ kind: 'idle' })
}
```

For `<video>` and `<audio>`, pause and clear `src` before revoking:
```typescript
if (videoRef.current) {
  videoRef.current.pause()
  videoRef.current.src = ''
}
```

**Acceptance**: Timeline displays items sorted by `capturedAt` DESC, tapping an item shows decrypted file in modal, closing modal revokes object URL, no decrypted content persists after close.

---

### Task 6: Legal Export Screen (1.5 hours)

**Goal**: "Generate Legal Export" button → Cloud Function → PDF download.

#### 6.1 Create `src/screens/LegalExportScreen.tsx`
Scaffold with route structure:
- Read `incidentId` from `useParams()`
- Single state machine: `ExportState`

#### 6.2 State machine
```typescript
type ExportState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'done'; downloadUrl: string; generatedAt: Date }
  | { kind: 'error'; message: string; errorCode?: string }
```

#### 6.3 Generate button
```tsx
<button
  className="btn btn-primary"
  disabled={exportState.kind === 'generating'}
  onClick={handleGenerate}
>
  {exportState.kind === 'generating' ? 'Generating…' : 'Generate Legal Export'}
</button>
```

#### 6.4 `handleGenerate` implementation
```typescript
async function handleGenerate() {
  setExportState({ kind: 'generating' })
  try {
    const fn = httpsCallable<{ incidentId: string }, { pdf: string }>(fns, 'generateLegalExport')
    const result = await fn({ incidentId })
    const pdfBase64 = result.data.pdf
    const pdfBytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0))
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    const objectUrl = URL.createObjectURL(blob)
    triggerDownload(objectUrl, `raksha-export-${incidentId}.pdf`)
    setExportState({ kind: 'done', downloadUrl: objectUrl, generatedAt: new Date() })
  } catch (err) {
    const { message, errorCode } = parseExportError(err)
    setExportState({ kind: 'error', message, errorCode })
  }
}
```

#### 6.5 `triggerDownload` helper
```typescript
function triggerDownload(objectUrl: string, filename: string) {
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke after 10 s to allow download to start
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
}
```

#### 6.6 `parseExportError` helper
Maps Firebase error codes to user-friendly messages per design.md §Error parsing.

#### 6.7 "Done" state UI
Show success banner + note that the download URL expires after 10 seconds. After 10s, hide "Download again" link and show only "Generate new export" button (which re-calls the function).

**Acceptance**: Generate button calls `generateLegalExport`, triggers PDF download, shows success state, handles all error cases with clear messages.

---

### Task 7: Routing + CountdownScreen Integration (30 min)

**Goal**: Wire three new routes, add "Add evidence" link to CountdownScreen.

#### 7.1 Update `App.tsx`
Inside the `<RequireAuth>` block, add three routes:
```tsx
<Route path="/evidence/capture"               element={<EvidenceCaptureScreen />} />
<Route path="/incidents/:incidentId/evidence" element={<EvidenceTimelineScreen />} />
<Route path="/incidents/:incidentId/export"   element={<LegalExportScreen />} />
```

Import the three screen components at the top of `App.tsx`.

#### 7.2 Update `CountdownScreen.tsx`
When `status === 'active'`, add a link below the "I'm safe — cancel now" button:
```tsx
{status === 'active' && sessionId && (
  <Link
    to={`/evidence/capture?incidentId=${sessionId}`}
    className="btn btn-ghost"
    style={{ maxWidth: '260px', fontSize: '0.875rem' }}
  >
    📎 Add evidence to this incident
  </Link>
)}
```

**Acceptance**: All three routes are accessible, CountdownScreen shows the evidence link when SOS is active, clicking the link navigates to `/evidence/capture?incidentId={sessionId}`.

---

### Task 8: Integration Testing (1.5 hours)

**Goal**: End-to-end verification with Firebase Emulator Suite.

#### 8.1 Start emulator
```bash
firebase emulators:start --only firestore,storage,auth,functions
```

Ensure `VITE_USE_EMULATOR=true` in `client/app/.env`.

#### 8.2 Test Capture flow
1. Navigate to `/home`, trigger an SOS (shake simulation or manual button)
2. Once status is `active`, click "Add evidence to this incident"
3. Select a test image file
4. Verify: progress indicator appears, upload completes, navigate to Timeline
5. Check Firestore emulator UI: evidence document exists with `status: 'available'`

#### 8.3 Test Timeline flow
1. Navigate to `/incidents/{sessionId}/evidence`
2. Verify: evidence item appears in list with correct filename, timestamp, status chip
3. Tap the item
4. Verify: modal opens, image is displayed (or video/audio plays)
5. Close modal
6. Open browser dev tools → Application → Memory: verify object URL is revoked (attempt to fetch it returns 404 or blob: URL not found)

#### 8.4 Test Export flow
1. Navigate to `/incidents/{sessionId}/export`
2. Click "Generate Legal Export"
3. Verify: loading spinner appears, PDF downloads after a few seconds
4. Open downloaded PDF, verify: cover page shows incidentId, evidence item appears, chain-of-custody table has entries

#### 8.5 Test error paths
- **No session**: Navigate to `/evidence/capture` without query param → shows "No active SOS session" message
- **Empty incident**: Navigate to `/incidents/fake-id/evidence` → shows "No evidence captured yet"
- **Export no evidence**: Navigate to `/incidents/fake-id/export`, click Generate → shows "No evidence available for this incident"
- **Permission denied**: (Advanced) Revoke access via `revokeEvidenceAccess` CF, then try to view → modal shows permission error

**Acceptance**: All flows work end-to-end in emulator, no console errors, decrypted content is properly revoked.

---

### Task 9: Polish + Documentation (30 min)

**Goal**: Final UX touches and inline code comments.

#### 9.1 Loading states
Ensure all three screens show `.spinner` during loading phases:
- Capture: hashing, uploading
- Timeline: initial query
- Export: generating

#### 9.2 Empty states
- Capture: "No active SOS session" (already covered in Task 4)
- Timeline: "No evidence captured yet" (card with message + link to `/evidence/capture?incidentId={incidentId}`)
- Export: handled by backend error (Task 6)

#### 9.3 Accessibility
- All buttons have `aria-label` or text labels
- File input has `aria-describedby` pointing to helper text
- Modal has `role="dialog"` and `aria-modal="true"`
- Status chips have `aria-label` describing the status

#### 9.4 Inline comments
Add comment blocks at the top of each screen explaining:
- State machine phases (Capture)
- Timestamp deserialization requirement (Timeline)
- Object URL lifecycle + revocation timing (Timeline modal, Export download)

#### 9.5 README update (optional)
Add a section to `client/app/README.md` documenting the three Evidence Trail screens, their routes, and the Firestore index requirement.

**Acceptance**: All screens have clear loading/empty states, are accessible, and have inline comments explaining critical sections.

---

## Task Dependency Graph

```
Task 1 (Copy libs)
  └─► Task 2 (Shared utils — depends on copied types)
        ├─► Task 4 (Capture screen — uses adapters from Task 2)
        ├─► Task 5 (Timeline screen — uses timestamp utils from Task 2)
        └─► Task 6 (Export screen — uses timestamp utils from Task 2)

Task 3 (Firestore index — independent, can run anytime before Task 5)

Task 7 (Routing — depends on Tasks 4, 5, 6 being complete)

Task 8 (Integration testing — depends on Tasks 3, 4, 5, 6, 7)

Task 9 (Polish — depends on all prior tasks)
```

**Critical path**: Tasks 1 → 2 → 4 → 7 → 8 (Capture flow must work before integration tests)

**Parallel work**: Task 3 can run anytime. Tasks 5 and 6 can be implemented in parallel after Task 2.

---

## Testing Checklist

Before marking the feature complete, verify all acceptance criteria from requirements.md:

- [ ] Evidence Capture screen accessible at `/evidence/capture`
- [ ] File picker only visible when SOS session is active (query param present)
- [ ] SHA-256 hash computed client-side before upload (via `captureEvidence` orchestrator)
- [ ] `captureEvidence` called with correct parameters (userId, incidentId, deviceInfo, gpsAtCapture)
- [ ] Upload progress indicator displayed
- [ ] Success/failure messages displayed appropriately
- [ ] Evidence Timeline accessible at `/incidents/:incidentId/evidence`
- [ ] Timeline displays all evidence items for the incident with correct metadata
- [ ] Tapping an item calls `serveEvidenceFile` and displays the decrypted file in modal
- [ ] Object URL revoked on modal close — no decrypted content persists
- [ ] Legal Export accessible at `/incidents/:incidentId/export`
- [ ] "Generate Legal Export" button calls `generateLegalExport`
- [ ] PDF download link appears on success
- [ ] Fail-whole error message displayed if any file is inaccessible
- [ ] "Add evidence" button visible during active SOS session
- [ ] All screens use existing design tokens and layout classes
- [ ] All Firebase calls route to emulator when `VITE_USE_EMULATOR=true`
- [ ] All timestamps handled as native `Date` objects
- [ ] No Firestore `Timestamp` objects in React state
- [ ] Firestore composite index created and functional

---

## Known Limitations (Out of Scope)

These are explicitly deferred per requirements.md §Out of Scope:

1. **Edit/Delete Evidence**: No UI for modifying or deleting evidence items (immutable by design).
2. **Evidence Filtering**: No date-range or status filters on the Timeline.
3. **Chain-of-Custody Detail View**: Full custody log is only available in the PDF export, not displayed in the UI.
4. **Real-Time Updates**: Timeline uses static `getDocs` query on mount, not `onSnapshot`.
5. **Evidence Sharing UI**: Granting/revoking access to contacts is not exposed.
6. **Signed Time-Limited URLs**: Backend should be refactored to return signed URLs instead of raw base64 bytes (future work tracked in requirements.md).

---

## Estimated Time

| Task | Est. Time |
|---|---|
| 1. Copy libs | 45 min |
| 2. Shared utils | 1 hour |
| 3. Firestore index | 10 min |
| 4. Capture screen | 3 hours |
| 5. Timeline screen | 2.5 hours |
| 6. Export screen | 1.5 hours |
| 7. Routing + integration | 30 min |
| 8. Integration testing | 1.5 hours |
| 9. Polish | 30 min |
| **Total** | **11.5 hours** |

For a developer unfamiliar with the RAKSHA codebase, add 50% buffer (~17 hours total). For an experienced RAKSHA contributor, the low end (8–9 hours) is achievable.

---

## Post-Implementation: Production Readiness

Before deploying to production, complete these additional steps (not part of this feature scope):

1. **Deploy Firestore index**: `firebase deploy --only firestore:indexes`
2. **Security rules audit**: Verify `firestore.rules` and `storage.rules` match the Evidence Trail backend design (already correct if backend was deployed).
3. **Mobile testing**: Test file picker with camera/microphone on real Android/iOS devices (Capacitor's `capture` attribute behavior varies by platform).
4. **Performance**: Verify Timeline query performance with 100+ evidence items per incident (current design is pagination-free; add pagination if needed).
5. **Backend refactor (future)**: Replace `serveEvidenceFile` raw-bytes response with signed time-limited URLs (tracked in requirements.md Out of Scope §6).
