# Technical Design — Evidence Trail UI

## Overview

Three React/TypeScript screens that wire the fully-implemented Evidence Trail backend into the RAKSHA PWA. All backend contracts are fixed; this design only concerns client-side state management, call sequencing, and component structure.

The three screens are:

| Screen | Route | Primary backend calls |
|---|---|---|
| Evidence Capture | `/evidence/capture` | Firestore create (via `captureEvidence`), Storage upload, `reportUploadFailure` |
| Evidence Timeline | `/incidents/:incidentId/evidence` | Firestore query, `serveEvidenceFile` |
| Legal Export | `/incidents/:incidentId/export` | `generateLegalExport` |

Plus a one-line addition to `CountdownScreen` linking to `/evidence/capture` when SOS status is `active`.

---

## Key Constraints (Non-Negotiable)

These follow from the requirements and from the architecture of the Evidence Trail backend:

1. **No Firestore Timestamp in state**: All timestamp fields from Firestore must be converted to native `Date` at the deserialization boundary via `.toDate()` (if a Firestore Timestamp) or left as-is (if already a Date). Never store raw Firestore Timestamps in React state or component props.

2. **In-memory-only decrypted content**: `serveEvidenceFile` returns `{ data: string (base64), mimeType: string }`. The UI converts this to a Blob and creates an object URL. The object URL is revoked immediately when the modal closes. No decrypted bytes persist in localStorage, IndexedDB, cache, or component state after dismissal.

3. **No client-side decryption**: The UI never reads Firebase Storage objects directly. All file access goes through `serveEvidenceFile`. Storage security rules deny all client reads (`allow read: if false`).

4. **No post-creation Firestore writes**: After creating an evidence document, the client never writes to it again. All `status` transitions and `chainOfCustody` appends go through Cloud Functions. Firestore security rules deny all client updates (`allow update: if false`).

5. **`sessionId` = `incidentId`**: The SOS session system creates documents at `/sosSessions/{sessionId}`. The Evidence Trail system uses `incidentId` to scope evidence. For this frontend, `sessionId` from `useCountdown` is passed as the `incidentId` to `captureEvidence` and to the Timeline/Export routes.

6. **captureEvidence orchestrator is a Node module**: `functions/src/client/captureEvidence.ts` uses Node-style imports (`require("crypto")`) in `computeSHA256Buffer`. The client-facing `computeSHA256.ts` is safe to reuse (uses Web Crypto API). The orchestrator itself must be adapted — see the Adapters section below.

---

## Architecture

```
CountdownScreen (modified)
  │  status === 'active'
  └─► Link to /evidence/capture?incidentId={sessionId}

EvidenceCaptureScreen (/evidence/capture)
  │
  ├─ reads incidentId from query param (falls back to "no session" message)
  ├─ file picker → computeSHA256 (Web Crypto) → progress state
  ├─ FirestoreAdapter (wraps db from firebase.ts)
  ├─ StorageAdapter   (wraps storage from firebase.ts + uploadBytesResumable for progress)
  ├─ FunctionsAdapter (wraps fns from firebase.ts)
  └─ captureEvidence() orchestrator (re-exported from shared location)

EvidenceTimelineScreen (/incidents/:incidentId/evidence)
  │
  ├─ Firestore query: collection('evidence')
  │    .where('incidentId','==',id)
  │    .where('userId','==',uid)
  │    .orderBy('metadata.capturedAt','desc')
  ├─ EvidenceItemCard list
  └─ EvidenceViewModal
       ├─ calls serveEvidenceFile (httpsCallable)
       ├─ base64 → Blob → URL.createObjectURL()
       └─ URL.revokeObjectURL() on close

LegalExportScreen (/incidents/:incidentId/export)
  │
  ├─ calls generateLegalExport (httpsCallable)
  ├─ receives { pdf: string } (base64 PDF)
  └─ triggers browser download via anchor + object URL (immediately revoked)
```

---

## Shared Utilities

### `src/utils/evidenceAdapters.ts` (new file)

The `captureEvidence` orchestrator was written for testing with injectable adapters (FirestoreAdapter, StorageAdapter, FunctionsAdapter). This utility creates the real Firebase SDK adapters for use in the browser:

```typescript
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { ref, uploadBytesResumable } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { db, storage, fns } from '../firebase'
import type { FirestoreAdapter, StorageAdapter, FunctionsAdapter } from '../../functions/src/client/captureEvidence'

// UploadProgressCallback: called with (bytesTransferred, totalBytes) during upload
export type UploadProgressCallback = (transferred: number, total: number) => void

export function makeFirestoreAdapter(): FirestoreAdapter {
  return {
    async createDocument(evidenceId, docData) {
      await setDoc(doc(db, 'evidence', evidenceId), docData)
    },
    async getDocument(evidenceId) {
      const snap = await getDoc(doc(db, 'evidence', evidenceId))
      return snap.exists() ? (snap.data() as ReturnType<typeof snap.data>) : null
    },
    async getDocumentWithRetry(evidenceId, retries) {
      // simple linear retry: attempt up to (retries + 1) times
      let lastErr: unknown
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await this.getDocument(evidenceId)
        } catch (e) {
          lastErr = e
        }
      }
      throw lastErr
    },
  }
}

export function makeStorageAdapter(onProgress?: UploadProgressCallback): StorageAdapter {
  return {
    async upload(storageRef, data, mimeType) {
      const fileRef = ref(storage, storageRef)
      const task = uploadBytesResumable(fileRef, data, { contentType: mimeType })
      return new Promise((resolve, reject) => {
        task.on(
          'state_changed',
          (snap) => onProgress?.(snap.bytesTransferred, snap.totalBytes),
          reject,
          resolve,
        )
      })
    },
  }
}

export function makeFunctionsAdapter(): FunctionsAdapter {
  return {
    async call(name, data) {
      const fn = httpsCallable<Record<string, unknown>, Record<string, unknown>>(fns, name)
      const result = await fn(data)
      return result.data
    },
  }
}
```

### `src/utils/evidenceTimestamp.ts` (new file)

Centralises timestamp deserialization for all Firestore evidence reads:

```typescript
// Converts a value that may be a Firestore Timestamp, a Date, or an ISO string
// into a native Date. Returns null if the value is null/undefined.
export function toDate(value: unknown): Date | null {
  if (value == null) return null
  if (value instanceof Date) return value
  // Firestore Timestamp shape: { toDate(): Date }
  if (typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate(): Date }).toDate()
  }
  if (typeof value === 'string') return new Date(value)
  return null
}

// Like toDate but throws if value is not convertible — for required timestamp fields.
export function requireDate(value: unknown, fieldName: string): Date {
  const d = toDate(value)
  if (!d || isNaN(d.getTime())) {
    throw new Error(`EvidenceUI: timestamp field '${fieldName}' could not be deserialized (got ${typeof value})`)
  }
  return d
}

// Formats a Date for display: "Jan 15, 2026, 3:42 PM"
export function formatTimestamp(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}
```

### `src/utils/evidenceTypes.ts` (new file)

Client-side subset of `EvidenceDocument` with all timestamps as native `Date`:

```typescript
export type EvidenceStatus =
  | 'uploading' | 'processing' | 'available' | 'expired'
  | 'legal_hold' | 'failed' | 'integrity_failed' | 'encryption_failed'

export interface EvidenceItem {
  evidenceId: string
  incidentId: string
  type: 'photo' | 'video' | 'audio' | 'screenshot' | 'document'
  originalFilename: string
  mimeType: string
  sizeBytes: number
  status: EvidenceStatus
  capturedAt: Date        // ← always native Date
  retentionExpiresAt: Date | null
  custodyCount: number    // length of chainOfCustody array
}
```

This type is what the Timeline screen stores in state — it omits raw `chainOfCustody` entries, `sha256Hash`, `encryptionKeyRef`, and `encryptionIV` (not needed for display) to keep state minimal.

---

## Screen 1: EvidenceCaptureScreen

### Route

`/evidence/capture?incidentId={sessionId}`

The `incidentId` is passed as a **query parameter** (not `location.state`) so the link from CountdownScreen survives a page refresh. CountdownScreen passes its `sessionId` as the parameter.

### State machine

```
idle
  └─[user selects file]──► hashing (spinner, picker disabled)
        └─[hash done]────► uploading (progress bar, picker disabled)
              ├─[success]─► success (banner, navigate after 2 s)
              └─[error]──► error (banner, retry available — picker re-enabled)
```

### Component state

```typescript
type CapturePhase =
  | { kind: 'idle' }
  | { kind: 'hashing' }
  | { kind: 'uploading'; progressPct: number }
  | { kind: 'success' }
  | { kind: 'error'; message: string }
```

Single `useState<CapturePhase>` — no useState for individual fields like `progress` separately, which would cause extra renders during the upload progress callback.

### Full data flow

1. Read `incidentId` from `useSearchParams()`. If absent or blank → show "no active session" message.
2. User selects file from `<input type="file" accept="image/*,video/*,audio/*" capture>`.
3. `onChange` handler:
   - Sets phase to `{ kind: 'hashing' }`
   - Calls `computeSHA256(file)` (Web Crypto, from `computeSHA256.ts`) — but note: `captureEvidence` recomputes the hash internally; calling it here is only for showing the hash in a debug label if needed. The orchestrator handles the real computation. The UI just calls `captureEvidence`.
   - Calls `getCurrentHashedLocation()` concurrently with hash computation.
   - Sets phase to `{ kind: 'uploading', progressPct: 0 }`
   - Creates adapters: `makeFirestoreAdapter()`, `makeStorageAdapter(onProgress)`, `makeFunctionsAdapter()`
   - Calls `captureEvidence(evidenceId, file, userId, metadata, firestoreAdapter, storageAdapter, functionsAdapter, computeSHA256WebCrypto)`
   - `onProgress` callback: `setPhase({ kind: 'uploading', progressPct: Math.round(t/total*100) })`
4. On `UploadResult.success: true` → phase `success` → navigate to `/incidents/{incidentId}/evidence` after 2 s.
5. On `UploadResult.success: false` → phase `error` with `message`.

### evidenceId generation

Each upload needs a stable, unique `evidenceId`. Use `crypto.randomUUID()` (available in all modern browsers). Generated once at the moment the user selects a file; stored in a `useRef` so it survives re-renders without changing.

### computeSHA256 adapter

`captureEvidence` accepts an injectable `computeHash` parameter. Pass a thin wrapper:

```typescript
async function computeSHA256WebCrypto(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
```

This mirrors the Web Crypto path in `computeSHA256.ts` but takes an `ArrayBuffer` (already read by `captureEvidence` internally) rather than a `File`.

### "No session" gate

```
if (!incidentId) {
  return (
    <div className="screen-centered">
      <p className="text-muted">No active SOS session.</p>
      <Link to="/home" className="btn btn-ghost">Go home</Link>
    </div>
  )
}
```

---

## Screen 2: EvidenceTimelineScreen

### Route

`/incidents/:incidentId/evidence`

The `:incidentId` param is the `sessionId` from the SOS session.

### State

```typescript
type TimelineState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'loaded'; items: EvidenceItem[] }
  | { kind: 'error'; message: string }

type ViewState =
  | { kind: 'idle' }
  | { kind: 'loading'; evidenceId: string }
  | { kind: 'viewing'; evidenceId: string; objectUrl: string; mimeType: string }
  | { kind: 'error'; evidenceId: string; message: string }
```

Two independent pieces of state: `TimelineState` for the list, `ViewState` for the modal. Kept separate so a view error doesn't wipe out the already-loaded list.

### Firestore query

```typescript
const q = query(
  collection(db, 'evidence'),
  where('incidentId', '==', incidentId),
  where('userId', '==', uid),
  orderBy('metadata.capturedAt', 'desc')
)
const snap = await getDocs(q)
```

This requires a composite index on `(incidentId ASC, userId ASC, metadata.capturedAt DESC)` — documented in Tasks.

### Timestamp deserialization

Each document is mapped through a `deserializeEvidenceItem` function:

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

If `requireDate` throws (malformed data), the item is skipped and an error is logged — the rest of the list still loads.

### View flow (in-memory only)

```
user taps item
  └─► ViewState: { kind: 'loading', evidenceId }
        └─► httpsCallable('serveEvidenceFile')({ evidenceId })
              ├─[success]─► base64 → Uint8Array → Blob → URL.createObjectURL(blob)
              │             ViewState: { kind: 'viewing', objectUrl, mimeType }
              └─[error]──► ViewState: { kind: 'error', message }

user closes modal
  └─► URL.revokeObjectURL(objectUrl)   ← decrypted content destroyed
      ViewState: { kind: 'idle' }
```

The object URL exists only between the `createObjectURL` call and the `revokeObjectURL` call. There is no state for "previously viewed" — every tap is a fresh call to `serveEvidenceFile`. This enforces the access-control guarantee: if access is revoked after a previous view, the next tap will receive a `PERMISSION_DENIED` error.

### Modal rendering by MIME type

| mimeType prefix | Element |
|---|---|
| `image/*` | `<img src={objectUrl}>` |
| `video/*` | `<video src={objectUrl} controls>` |
| `audio/*` | `<audio src={objectUrl} controls>` |
| `application/pdf` | `<iframe src={objectUrl}>` |
| other | Download link: `<a href={objectUrl} download={filename}>` |

The `<video>` and `<audio>` elements pause and have their `src` cleared when the modal closes, before `revokeObjectURL` is called, to prevent the browser retaining a reference through an active media pipeline.

### Status chip colours

| Status | Chip class | Label |
|---|---|---|
| `uploading` | `chip-amber` | Uploading… |
| `processing` | `chip-amber` | Processing… |
| `available` | `chip-green` | Available |
| `legal_hold` | `chip-green` | Legal Hold |
| `expired` | `chip-amber` | Expired |
| `failed` | `chip-red` | Upload failed |
| `integrity_failed` | `chip-red` | Integrity error |
| `encryption_failed` | `chip-red` | Encryption error |

### Type icons

```typescript
const TYPE_ICONS: Record<EvidenceItem['type'], string> = {
  photo:      '📷',
  video:      '🎥',
  audio:      '🎤',
  screenshot: '🖼️',
  document:   '📄',
}
```

---

## Screen 3: LegalExportScreen

### Route

`/incidents/:incidentId/export`

### State

```typescript
type ExportState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'done'; downloadUrl: string; generatedAt: Date }
  | { kind: 'error'; message: string; errorCode?: string }
```

### Export flow

```
user presses "Generate Legal Export"
  └─► ExportState: { kind: 'generating' }
        └─► httpsCallable('generateLegalExport')({ incidentId })
              ├─[success]─► { pdf: base64String }
              │              Uint8Array → Blob(application/pdf)
              │              URL.createObjectURL(blob) → downloadUrl
              │              trigger <a download> programmatically
              │              ExportState: { kind: 'done', downloadUrl, generatedAt: new Date() }
              └─[error]──► parse error code
                            ExportState: { kind: 'error', message, errorCode }
```

### Download trigger

```typescript
function triggerDownload(objectUrl: string, filename: string) {
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Do NOT revoke immediately — the download needs the URL to remain valid
  // while the browser initiates the download. Revoke after a short delay.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
}
```

The 10-second delay before revocation is a browser compatibility measure — some browsers need a moment after `click()` before the download starts. After revocation, the `downloadUrl` in state becomes an invalid reference, but the download is already in progress.

The `downloadUrl` persisted in state (for the "Download again" link) will be stale after 10 seconds. Pressing "Download again" calls `triggerDownload` with the current `downloadUrl` which will be revoked by then. So: after 10 seconds, the "Download again" link is removed from the UI, leaving only a "Generate new export" option to re-run the function.

This is correct security behaviour: the PDF is not cached on the client; regenerating calls `serveEvidenceFile` internally again, re-checking current access rights.

### Error parsing

```typescript
function parseExportError(err: unknown): { message: string; errorCode?: string } {
  const code = (err as { code?: string }).code ?? ''
  if (code === 'functions/not-found') {
    return { message: 'No evidence available for this incident.', errorCode: code }
  }
  if (code === 'functions/permission-denied' || code === 'functions/unauthenticated') {
    return { message: 'You do not have permission to export this incident\'s evidence.', errorCode: code }
  }
  if (code === 'functions/internal') {
    const msg = (err as { message?: string }).message ?? ''
    // Backend embeds the failing evidenceId in the message
    const match = msg.match(/Failed to fetch evidence file for (.+)/)
    if (match) {
      return {
        message: `Export failed — evidence file could not be accessed: ${match[1]}. This may be a temporary Storage error. Try again in a moment.`,
        errorCode: code,
      }
    }
    return { message: 'Export failed due to a server error. Try again in a moment.', errorCode: code }
  }
  return { message: 'Export failed. Please try again.', errorCode: code }
}
```

---

## CountdownScreen Integration

One addition to the existing `CountdownScreen` — when `status === 'active'`, add an "Add evidence" link below the "I'm safe — cancel now" button:

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

This is the only change to `CountdownScreen`. No state changes, no new hooks, no routing changes — pure addition.

---

## Routing (App.tsx changes)

Three new routes added inside the `<RequireAuth>` group:

```tsx
<Route path="/evidence/capture"              element={<EvidenceCaptureScreen />} />
<Route path="/incidents/:incidentId/evidence" element={<EvidenceTimelineScreen />} />
<Route path="/incidents/:incidentId/export"  element={<LegalExportScreen />} />
```

---

## Firestore Index Requirements

The Timeline query requires a composite index. This must be added to `firestore.indexes.json`:

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

Without this index, Firestore will reject the `orderBy` + `where` query combination with an index-required error.

---

## Component File Structure

```
client/app/src/
  screens/
    EvidenceCaptureScreen.tsx      (new)
    EvidenceTimelineScreen.tsx     (new)
    LegalExportScreen.tsx          (new)
    CountdownScreen.tsx            (modified — one link added)
  utils/
    evidenceAdapters.ts            (new — FirestoreAdapter, StorageAdapter, FunctionsAdapter wrappers)
    evidenceTimestamp.ts           (new — toDate, requireDate, formatTimestamp)
    evidenceTypes.ts               (new — EvidenceItem, EvidenceStatus client types)
  App.tsx                          (modified — three new routes)
firestore.indexes.json             (modified or created — composite index)
```

All new files live under `client/app/src/`. None import from `functions/src/` directly — the `captureEvidence` orchestrator must be reimported or the adapters built inline. See the note below.

### Re-use of captureEvidence orchestrator

`functions/src/client/captureEvidence.ts` imports from `./validateFile.js` and `./checkIdempotency.js` using Node ESM `.js` extensions, which work fine in the Vite browser build **provided** the path alias is configured. The safest approach is to **copy the three client files** (`captureEvidence.ts`, `validateFile.ts`, `checkIdempotency.ts`) into `client/app/src/lib/evidence/` and strip the `.js` from the imports — the logic is identical, the types are self-contained, and this avoids a cross-package import that complicates the Vite config.

The `computeSHA256.ts` file has a Node `require("crypto")` path in `computeSHA256Buffer` that cannot run in the browser — but `captureEvidence` only calls the injectable `computeHash` parameter, not `computeSHA256Buffer` directly, so this is never invoked in the browser build. Copy the file anyway and mark the Node path with a `// Node only` comment.

---

## Error Display Convention

All three screens use the same convention for surfacing Firebase error codes in development:

```typescript
function formatError(err: unknown, publicMessage: string): string {
  if (import.meta.env.VITE_USE_EMULATOR === 'true') {
    const code = (err as { code?: string }).code ?? 'unknown'
    const msg  = (err as { message?: string }).message ?? ''
    return `${publicMessage} (${code}: ${msg})`
  }
  return publicMessage
}
```

In production (`VITE_USE_EMULATOR !== 'true'`), only the user-friendly message is shown.

---

## Security Properties Maintained

| Property | How UI enforces it |
|---|---|
| No persistent decrypted content | `revokeObjectURL` on modal close; `setTimeout(revoke, 10_000)` for downloads |
| No client Firestore writes after creation | `captureEvidence` is the only Firestore write path; all other screens are read-only |
| No direct Storage reads | All file access via `serveEvidenceFile` CF; no `getDownloadURL` or `getBytes` calls |
| Access-controlled views | Each view tap calls `serveEvidenceFile` fresh — a revoked user gets `PERMISSION_DENIED` on their next tap even if they previously viewed the file |
| No Firestore Timestamp in state | `requireDate` / `toDate` called at deserialization boundary; React state holds only native `Date` |
| Audit trail maintained | Every `serveEvidenceFile` call appends a `viewed` custody entry server-side — the UI doesn't need to do anything extra |

---

## Design Decisions

### Why query param for incidentId on Capture screen, not location.state?

`location.state` is lost on page refresh and is not accessible if the user opens the link in a new tab. A query param survives both. Since `incidentId` is not sensitive (it's a document ID, not a secret), passing it in the URL is fine.

### Why copy captureEvidence rather than import cross-package?

Vite resolves imports relative to the project root. A path like `../../functions/src/client/captureEvidence` would work in dev but break in production builds unless the Vite config explicitly includes the `functions/src` directory in the build scope. The functions package is a separate npm workspace; importing it as a workspace dependency would be the clean long-term approach, but for this feature it introduces more config risk than the simple copy. The copy is three small files with stable logic.

### Why not use Firestore `onSnapshot` for real-time updates?

The Evidence Trail does not need real-time updates on the Timeline. Evidence upload is initiated from the Capture screen; the user navigates to the Timeline after completion. A static `getDocs` query on mount is sufficient and simpler. Real-time listeners also add cleanup complexity and can produce intermediate states (e.g., `uploading` items briefly visible) that are confusing.

### Why keep ViewState separate from TimelineState?

A view error (e.g., `serveEvidenceFile` returns 403 because access was revoked) should not destroy the loaded list. Keeping them independent means a failed view attempt just shows an error in the modal while the list remains intact.

### Why defer object URL revocation for downloads by 10 seconds?

Chrome and Safari initiate the download asynchronously after `a.click()`. Revoking the URL synchronously causes the download to fail in some browsers. 10 seconds is conservative but safe. The PDF is already delivered to the browser's download manager by then; the object URL is no longer needed.
