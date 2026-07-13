# Implementation Plan: Evidence Trail

## Overview

Implementation of the tamper-proof, legally defensible RAKSHA Evidence Trail system. The plan proceeds foundation-first: shared TypeScript interfaces and utilities must exist before any Cloud Function touches them, and all Cloud Functions must be complete before the client-side upload flow wires into them. Security rules and tests come last, once there is working code to validate against.

Stack: React + TypeScript PWA (client), Firebase Firestore + Storage + Cloud Functions (Node 18, Admin SDK) + Auth, Google Cloud KMS, fast-check for property-based tests, Firebase Emulator Suite for integration tests.

---

## Tasks

- [ ] 1. Foundation — Shared Types, Utilities, and KMS Abstraction
  - [ ] 1.1 Define core TypeScript interfaces and type aliases
    - Create `src/types/evidence.ts` (or equivalent shared path) containing:
      - `EvidenceDocument` interface with all fields typed per design §Components and Interfaces
      - `EvidenceStatus` union type: `'uploading' | 'processing' | 'available' | 'expired' | 'legal_hold' | 'failed' | 'integrity_failed' | 'encryption_failed'`
      - `EvidenceMetadata` interface
      - `ChainOfCustodyEntry` interface with `timestamp: Date` (never Firestore Timestamp)
      - `CustodyAction` union type covering all 9 action values
      - `GrantedContact` interface for the sub-collection
      - All Date fields annotated as `Date` (never `Timestamp`)
    - _Requirements: 1.4, 5.2, 10.1, 11.1_
    - _Design: §Components and Interfaces — Data Models_
    - Dependencies: none

  - [ ] 1.2 Implement `assertDate` timestamp deserialization guard
    - Create `src/functions/utils/assertDate.ts`
    - Export `class TimestampDeserializationError extends Error`
    - Export `function assertDate(value: unknown, fieldName: string): Date` — throws `TimestampDeserializationError` if value is not `instanceof Date`
    - This function MUST be called at every point where Firestore data is read into typed evidence objects inside Cloud Functions
    - _Requirements: 10.3, 10.4_
    - _Design: §Timestamp Handling Rules_
    - Dependencies: 1.1

  - [ ] 1.3 Implement `computeIntegritySnapshot` utility
    - Create `src/functions/utils/integritySnapshot.ts`
    - Export `function computeIntegritySnapshot(doc: EvidenceDocument): string`
    - Use exactly the 8 immutable fields in lexicographic key order: `createdAt`, `evidenceId`, `incidentId`, `mimeType`, `originalFilename`, `sha256Hash`, `sizeBytes`, `userId`
    - Serialize `createdAt` as ISO 8601 string; all other fields as-is
    - Hash via Node.js `crypto.createHash('sha256')` over `JSON.stringify(snapshot)`
    - _Requirements: 3.3_
    - _Design: §Chain-of-Custody Append Protocol — integritySnapshot Computation_
    - Dependencies: 1.1

  - [ ] 1.4 Implement `appendCustodyEntry` shared transaction helper
    - Create `src/functions/utils/appendCustodyEntry.ts`
    - Export `async function appendCustodyEntry(tx: FirebaseFirestore.Transaction, ref: DocumentReference, entry: ChainOfCustodyEntry): Promise<void>`
    - Inside the transaction: read current `chainOfCustody`, spread-append the new entry, call `tx.update(ref, { chainOfCustody: [...current, entry], updatedAt: new Date() })`
    - `FieldValue.arrayUnion()` MUST NOT be used anywhere in this file or called from any function that appends custody entries
    - `entry.timestamp` MUST be `new Date()` — never `Timestamp.now()` or `Timestamp.fromDate()`
    - All Cloud Functions that append custody entries MUST call this helper — no inline array appends permitted
    - _Requirements: 5.3, 5.4, 5.7, 10.1, 10.2_
    - _Design: §Chain-of-Custody Append Protocol — Mandatory Transaction Pattern_
    - Dependencies: 1.1, 1.3

  - [ ] 1.5 Implement KMS interface, KMSMock, and createKMSClient factory
    - Create `src/functions/kms/kms.interface.ts` with `KMSClient` interface exposing:
      - `generateDataEncryptionKey(keyRingRef: string): Promise<{ encryptedDEK: string; plaintextDEK: Buffer; iv: Buffer }>`
      - `decryptDataEncryptionKey(encryptedDEK: string, keyRingRef: string): Promise<Buffer>`
    - Create `src/functions/kms/KMSMock.ts` implementing `KMSClient`:
      - Uses `crypto.randomBytes(32)` for DEK and `crypto.randomBytes(16)` for IV
      - Stores `encryptedDEK → plaintextDEK` in an in-process Map
      - Throws if `decryptDataEncryptionKey` is called with an unknown `encryptedDEK`
    - Create `src/functions/kms/CloudKMSClient.ts` implementing `KMSClient` using `@google-cloud/kms`
    - Create `src/functions/kms/createKMSClient.ts` exporting `function createKMSClient(): KMSClient`:
      - Returns `new KMSMock()` if `process.env.FUNCTIONS_EMULATOR === 'true'` OR `process.env.NODE_ENV === 'test'`
      - Returns `new CloudKMSClient()` otherwise
    - No Cloud Function may be implemented without importing from `kms.interface.ts` first (enforced by task order)
    - _Requirements: 4.3, 4.4, 4.5_
    - _Design: §KMS Encryption Interface_
    - Dependencies: none (can be implemented in parallel with 1.1–1.4)

  - [ ] 1.6 Implement `aesGcmEncrypt` and `aesGcmDecrypt` utilities
    - Create `src/functions/utils/aesGcm.ts`
    - Export `function aesGcmEncrypt(plaintext: Buffer, key: Buffer, iv: Buffer): Buffer`
    - Export `function aesGcmDecrypt(ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer` — must throw if authentication tag validation fails
    - Use Node.js `crypto.createCipheriv('aes-256-gcm', ...)` / `createDecipheriv`
    - _Requirements: 4.1, 4.6_
    - _Design: §onEvidenceCreate Cloud Function Pipeline — Steps 6 and (implicitly) serveEvidenceFile_
    - Dependencies: none (can be implemented in parallel with 1.1–1.5)

  - [ ] 1.7 Implement `getRetentionPeriodDays` configuration utility
    - Create `src/functions/utils/retentionConfig.ts`
    - Export `function getRetentionPeriodDays(): number` — reads from environment/config, validates range [1, 3650], throws `RangeError` if outside that range
    - _Requirements: 8.1, 8.7_
    - _Design: §processEvidenceExpiry Function Design — Step 1_
    - Dependencies: none

- [ ] 2. Cloud Function: onEvidenceCreate
  - [ ] 2.1 Implement `onEvidenceCreate` — Steps 1 and 12 scaffold (status transitions + error path)
    - Create `src/functions/onEvidenceCreate.ts` triggered by `functions.firestore.document('evidence/{evidenceId}').onCreate`
    - Step 1: conditional transaction `uploading → processing`; abort if status ≠ `uploading` at commit time; update `updatedAt: new Date()`
    - Step 12 (error scaffold): wrap steps 2–11 in try/catch; on unrecoverable error perform conditional transaction setting `status: 'failed'` or `'encryption_failed'` only if status is still `uploading` or `processing`; call `appendCustodyEntry` helper; log and yield if status changed by concurrent resume path
    - Deserialize all Firestore timestamp fields through `assertDate` before use
    - _Requirements: 3.5, 4.6, 11.3, 11.5_
    - _Design: §onEvidenceCreate — Steps 1, 12_
    - Dependencies: 1.1, 1.2, 1.4, 1.5

  - [ ] 2.2 Implement `onEvidenceCreate` — Steps 2–4 (download, hash verify, integrity_failed path)
    - Step 2: download raw bytes from Storage via Admin SDK with up to 3 retries on transient errors
    - Step 3: compute server-side SHA-256 over downloaded bytes using `crypto.createHash('sha256')`
    - Step 4: if `serverHash !== doc.sha256Hash`, run transaction appending `status_changed` custody entry (metadata: `{ expectedHash, computedHash, reason: 'hash_mismatch' }`), set `status: 'integrity_failed'`, call `appendCustodyEntry` helper; return to stop pipeline
    - _Requirements: 3.1, 3.2, 3.5_
    - _Design: §onEvidenceCreate — Steps 2–4_
    - Dependencies: 2.1, 1.3, 1.4

  - [ ] 2.3 Implement `onEvidenceCreate` — Steps 5–8 (KMS keygen, AES encrypt, Storage overwrite, key refs)
    - Step 5: call `createKMSClient().generateDataEncryptionKey(KEY_RING_REF)` with up to 3 retries; on failure transition to `encryption_failed` via Step 12 path
    - Step 6: call `aesGcmEncrypt(rawBytes, plaintextDEK, iv)`
    - Step 7: overwrite Storage object with encrypted bytes via Admin SDK; content-type `application/octet-stream`
    - Step 8: encode IV as base64 (16 bytes → 24-char string); store `encryptionKeyRef = encryptedDEK`, `encryptionIV = iv.toString('base64')`; for `encryption_failed` path — delete Storage object before transition commits (retry deletion up to 3 times; set status regardless if deletion still fails, log critical alert)
    - _Requirements: 4.1, 4.2, 4.6_
    - _Design: §onEvidenceCreate — Steps 5–8_
    - Dependencies: 2.2, 1.5, 1.6

  - [ ] 2.4 Implement `onEvidenceCreate` — Steps 9–11 (retentionExpiresAt, integritySnapshot, final transaction)
    - Step 9: call `getRetentionPeriodDays()`; compute `retentionExpiresAt = new Date(createdAt.getTime() + retentionDays * 86_400_000)`
    - Step 10: call `computeIntegritySnapshot(doc)` for the `uploaded` entry
    - Step 11: single conditional transaction checking `status === 'processing'`; atomically writes `status: 'available'`, `encryptionKeyRef`, `encryptionIV`, `retentionExpiresAt`, `updatedAt: new Date()`, and appends `uploaded` custody entry via `appendCustodyEntry` helper
    - Confirm `FieldValue.arrayUnion()` is absent from this file
    - _Requirements: 3.3, 4.1, 4.2, 5.1, 8.1, 11.4_
    - _Design: §onEvidenceCreate — Steps 9–11_
    - Dependencies: 2.3, 1.3, 1.4, 1.7

  - [ ]* 2.5 Write unit tests for `onEvidenceCreate` pipeline
    - Test each terminal branch: `integrity_failed` (hash mismatch), `encryption_failed` (KMS failure after 3 retries), `failed` (unrecoverable error, conditional abort when resume wins)
    - Test happy path: full steps 1–11 complete, status reaches `available`, custody entry present
    - Test Storage deletion for `encryption_failed` path (delete called before status transition commits)
    - Use Firebase Emulator Suite + KMSMock (`NODE_ENV=test`)
    - All timestamp assertions use `instanceof Date`
    - _Requirements: 3.1, 3.2, 4.1, 4.6, 11.3, 11.4, 11.5_
    - Dependencies: 2.4

- [ ] 3. Cloud Function: reportUploadFailure
  - [ ] 3.1 Implement `reportUploadFailure` HTTPS callable Cloud Function
    - Create `src/functions/reportUploadFailure.ts`
    - Step 1: verify Firebase Auth token; reject 401 if unauthenticated
    - Step 2: read `/evidence/{evidenceId}`; reject 404 if not found
    - Step 3: verify `caller.uid === evidence.userId`; reject 403 if not owner
    - Step 4: conditional transaction — if `status === 'uploading'`: set `status: 'failed'`, `updatedAt: new Date()`, append `status_changed` custody entry (`performedBy: 'cloud_function'`, `metadata: { reason: 'client_storage_failure' }`) via `appendCustodyEntry` helper; if `status !== 'uploading'`: abort and return `{ outcome: 'ALREADY_PROCESSING' }`
    - Step 5: return `{ outcome: 'FAILED' }` to client when transaction committed `failed`
    - Deserialize all timestamp fields through `assertDate`
    - _Requirements: 1.8, 5.1, 5.4, 6.2_
    - _Design: §reportUploadFailure Function Design_
    - Dependencies: 1.1, 1.2, 1.4

  - [ ]* 3.2 Write unit tests for `reportUploadFailure`
    - Test: unauthenticated call → 401
    - Test: unknown evidenceId → 404
    - Test: wrong uid → 403
    - Test: status `uploading` → commits `failed`, custody entry present
    - Test: status `processing` → returns `ALREADY_PROCESSING`, no Firestore write
    - Use Firebase Emulator Suite
    - _Requirements: 1.8, 6.2_
    - Dependencies: 3.1

- [ ] 4. Cloud Function: retriggerProcessing
  - [ ] 4.1 Implement `retriggerProcessing` HTTPS callable Cloud Function
    - Create `src/functions/retriggerProcessing.ts`
    - Step 1: verify Firebase Auth token; reject 401
    - Step 2: read `/evidence/{evidenceId}`; reject 404 if not found
    - Step 3: verify `caller.uid === evidence.userId`; reject 403
    - Step 4: verify `status === 'uploading'` AND `updatedAt` was updated within the last 30 seconds (i.e., resume transaction just claimed the document); reject if not — prevents double-triggering
    - Step 5: verify file exists at `evidence.storageRef` in Storage; return `FILE_NOT_FOUND` if not present
    - Step 6: execute `onEvidenceCreate` pipeline steps 2–11 directly on the existing document using Admin SDK; Step 1's conditional write (`uploading → processing`) uses the same conditional transaction as the onCreate trigger
    - Chain-of-custody log is preserved from before the stall; `uploaded` entry appended at Step 11 as usual
    - Deserialize all timestamp fields through `assertDate`
    - _Requirements: 2.3, 2.7, 11.5_
    - _Design: §Race Condition Resolution — The Resume Mechanism: retriggerProcessing_
    - Dependencies: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 2.4

  - [ ]* 4.2 Write unit tests for `retriggerProcessing`
    - Test: unauthenticated → 401; wrong owner → 403; not found → 404
    - Test: status not `uploading` → rejected (double-trigger prevention)
    - Test: `updatedAt` older than 30s → rejected
    - Test: file missing in Storage → returns `FILE_NOT_FOUND`
    - Test: happy path — pipeline steps 2–11 complete, status reaches `available`
    - _Requirements: 2.3, 2.7_
    - Dependencies: 4.1

- [ ] 5. Cloud Function: serveEvidenceFile
  - [ ] 5.1 Implement `serveEvidenceFile` HTTPS callable Cloud Function
    - Create `src/functions/serveEvidenceFile.ts`
    - Step 1: verify Firebase Auth token; reject 401
    - Step 2: read `/evidence/{evidenceId}`; reject 404 if not found
    - Step 3: authorization — caller uid matches `evidence.userId` OR active non-revoked GrantedContact exists at `/grantedContacts/{evidence.userId}/contacts/{uid}`; reject 403 otherwise
    - Step 4: fetch encrypted bytes from Storage (Admin SDK); return 503 on inaccessible file
    - Step 5: call `createKMSClient().decryptDataEncryptionKey(evidence.encryptionKeyRef, KEY_RING_REF)`; return 500 on failure, transmit no bytes
    - Step 6: decode `evidence.encryptionIV` from base64 to 16-byte Buffer; call `aesGcmDecrypt(ciphertext, plaintextDEK, iv)`; return 500 with integrity error on authentication tag failure, transmit no bytes
    - Step 7: append `viewed` custody entry via `appendCustodyEntry` helper within a transaction; entry timestamp = `new Date()`; this append MUST complete within 5 seconds of function invocation; if append fails → return 500, transmit no bytes
    - Step 8: stream decrypted bytes with `Content-Type: evidence.mimeType`
    - Deserialize all timestamp fields through `assertDate`
    - _Requirements: 5.6, 6.6, 7.1, 7.2, 7.3_
    - _Design: §serveEvidenceFile Function Design_
    - Dependencies: 1.1, 1.2, 1.4, 1.5, 1.6

  - [ ]* 5.2 Write unit tests for `serveEvidenceFile`
    - Test: unauthenticated → 401; non-owner non-contact → 403; unknown evidenceId → 404
    - Test: Storage inaccessible → 503; KMS failure → 500; decryption auth-tag failure → 500
    - Test: custody append failure → 500, no bytes returned
    - Test: happy path owner + happy path granted contact → returns decrypted bytes with correct content-type and `viewed` entry recorded
    - _Requirements: 5.5, 5.6, 6.6, 7.1, 7.2_
    - Dependencies: 5.1

- [ ] 6. Cloud Function: generateLegalExport
  - [ ] 6.1 Implement `generateLegalExport` HTTPS callable Cloud Function — auth, authz, existence check
    - Create `src/functions/generateLegalExport.ts`
    - Step 1: verify Firebase Auth token upfront; reject 401 before any query
    - Step 2: authorization check — owner or active GrantedContact; reject 403 before assembly begins
    - Step 3: query Firestore for evidence where `incidentId == requestedId`; if empty → reject 404 with descriptive error
    - Deserialize all timestamp fields through `assertDate`
    - _Requirements: 9.1, 9.4, 9.7_
    - _Design: §generateLegalExport Function Design — Steps 1–3_
    - Dependencies: 1.1, 1.2

  - [ ] 6.2 Implement `generateLegalExport` — per-item decrypt and fail-whole on inaccessible files
    - Step 4: for each evidence item — fetch encrypted bytes from Storage; decrypt via KMS + `aesGcmDecrypt`; collect metadata fields and full `chainOfCustody` array
    - Step 5: if ANY Storage fetch failed in step 4, reject entire request with error identifying each inaccessible file; return no partial output
    - _Requirements: 9.2, 9.6_
    - _Design: §generateLegalExport — Steps 4–5_
    - Dependencies: 6.1, 1.5, 1.6

  - [ ] 6.3 Implement `generateLegalExport` — PDF assembly and exported custody entries
    - Step 6: assemble PDF:
      - Cover page: incidentId, export timestamp, requesting user, total evidence count
      - Per evidence item: embedded file (or SHA-256 reference for video/audio), metadata table, chain-of-custody table
      - Integrity verification report: `sha256Hash`, current status; if `expired` include notice `"This evidence has passed its retention period. Retention expired: {retentionExpiresAt.toISOString()}"`
    - Step 7: append `exported` custody entry to each evidence item via `appendCustodyEntry` helper in individual transactions; initiate all concurrently with `Promise.all`; any failure rejects entire export
    - Step 8: return PDF to caller
    - _Requirements: 9.2, 9.3, 9.5, 9.6_
    - _Design: §generateLegalExport — Steps 6–8_
    - Dependencies: 6.2, 1.3, 1.4

  - [ ]* 6.4 Write unit tests for `generateLegalExport`
    - Test: unauthenticated → 401; unauthorized → 403; no evidence → 404
    - Test: any Storage file inaccessible → error identifying inaccessible files, no PDF returned
    - Test: expired evidence → PDF contains retention-expired notice with correct `retentionExpiresAt`
    - Test: `exported` custody entries appended to all items concurrently; single item append failure → entire export rejected
    - Test: happy path — complete PDF with all sections, all items decrypted correctly
    - _Requirements: 9.1–9.7_
    - Dependencies: 6.3

- [ ] 7. Cloud Function: processEvidenceExpiry
  - [ ] 7.1 Implement `processEvidenceExpiry` scheduled Cloud Function
    - Create `src/functions/processEvidenceExpiry.ts` triggered by Cloud Scheduler
    - Step 1: call `getRetentionPeriodDays()`; if throws (invalid config) → log critical error and abort entire run, process no documents
    - Step 2: query `evidence` where `retentionExpiresAt < new Date()` AND `status` not-in `['legal_hold', 'expired', 'failed', 'integrity_failed', 'encryption_failed']`
    - Step 3: for each document — run conditional transaction: re-check status is still eligible; if `ABORT_INELIGIBLE`, log and skip; otherwise append `status_changed` custody entry (`metadata: { priorStatus, newStatus: 'expired' }`) via `appendCustodyEntry` helper and set `status: 'expired'`; on any other error, log with `evidenceId` and continue to next document
    - Step 4: log total processed / succeeded / failed
    - Deserialize all timestamp fields through `assertDate`
    - _Requirements: 8.2, 8.3, 8.4, 8.7_
    - _Design: §processEvidenceExpiry Function Design_
    - Dependencies: 1.1, 1.2, 1.4, 1.7

  - [ ]* 7.2 Write unit tests for `processEvidenceExpiry`
    - Test: invalid retention config → aborts entire run, no documents processed
    - Test: document in `legal_hold` → never expired regardless of `retentionExpiresAt`
    - Test: document concurrently moved to `legal_hold` between query and transaction → `ABORT_INELIGIBLE`, log and skip
    - Test: individual document Firestore error → logged, other documents still processed
    - Test: happy path — eligible documents transition to `expired` with correct custody entry
    - _Requirements: 8.2, 8.3, 8.4_
    - Dependencies: 7.1

- [ ] 8. Cloud Functions: Access Control
  - [ ] 8.1 Implement `setLegalHold` HTTPS callable Cloud Function
    - Create `src/functions/setLegalHold.ts`
    - Verify auth (401); read document (404); verify owner (403)
    - Validate `legalHoldReason`: must be non-empty and ≤ 1000 characters; reject with validation error otherwise
    - Conditional transaction: set `status: 'legal_hold'`, `legalHoldReason`; append `legal_hold_set` custody entry via `appendCustodyEntry` helper
    - Deserialize timestamps through `assertDate`
    - _Requirements: 8.3, 8.5_
    - _Design: §Evidence Status State Machine — Transition Table_
    - Dependencies: 1.1, 1.2, 1.4

  - [ ] 8.2 Implement `releaseLegalHold` HTTPS callable Cloud Function
    - Create `src/functions/releaseLegalHold.ts`
    - Verify auth (401); read document (404); verify owner (403)
    - Verify current status is `legal_hold`; reject with error if not
    - Conditional transaction: compute new `retentionExpiresAt = new Date() + retentionDays * 86_400_000`; set `status: 'available'`; append `legal_hold_released` custody entry via `appendCustodyEntry` helper
    - Deserialize timestamps through `assertDate`
    - _Requirements: 8.6_
    - Dependencies: 1.1, 1.2, 1.4, 1.7

  - [ ] 8.3 Implement `grantEvidenceAccess` HTTPS callable Cloud Function
    - Create `src/functions/grantEvidenceAccess.ts`
    - Verify auth (401); verify caller is evidence owner (403)
    - Write GrantedContact document at `/grantedContacts/{ownerId}/contacts/{contactUid}` with `{ contactUid, ownerId, grantedAt: new Date(), revoked: false, revokedAt: null }`
    - Append `granted` custody entry to evidence document via `appendCustodyEntry` helper (metadata: owner uid, contact uid, ISO timestamp)
    - Deserialize timestamps through `assertDate`
    - _Requirements: 7.4_
    - Dependencies: 1.1, 1.2, 1.4

  - [ ] 8.4 Implement `revokeEvidenceAccess` HTTPS callable Cloud Function
    - Create `src/functions/revokeEvidenceAccess.ts`
    - Verify auth (401); verify caller is evidence owner (403)
    - Update GrantedContact document: set `revoked: true`, `revokedAt: new Date()`
    - Append `revoked` custody entry to evidence document via `appendCustodyEntry` helper
    - Deserialize timestamps through `assertDate`
    - _Requirements: 7.5_
    - Dependencies: 1.1, 1.2, 1.4

  - [ ] 8.5 Implement `recordEvidenceViewed` HTTPS callable Cloud Function
    - Create `src/functions/recordEvidenceViewed.ts` (for any pathway that needs to record a view event outside `serveEvidenceFile`)
    - Verify auth (401); verify owner or active GrantedContact (403)
    - Append `viewed` custody entry via `appendCustodyEntry` helper within 5 seconds of invocation
    - Deserialize timestamps through `assertDate`
    - _Requirements: 5.6_
    - Dependencies: 1.1, 1.2, 1.4

  - [ ]* 8.6 Write unit tests for access control Cloud Functions
    - Test `setLegalHold`: empty `legalHoldReason` → rejected; reason > 1000 chars → rejected; valid reason → status `legal_hold`, custody entry present
    - Test `releaseLegalHold`: document not in `legal_hold` → rejected; valid release → status `available`, new `retentionExpiresAt` set, custody entry present
    - Test `grantEvidenceAccess` + `revokeEvidenceAccess`: GrantedContact created/revoked, custody entries appended
    - _Requirements: 7.4, 7.5, 8.3, 8.5, 8.6_
    - Dependencies: 8.1, 8.2, 8.3, 8.4

- [ ] 9. Checkpoint — Core Cloud Functions Complete
  - Ensure all tests pass for phases 1–8, ask the user if questions arise.

- [ ] 10. Client: Upload Flow
  - [ ] 10.1 Implement `validateFile` and `computeSHA256` client utilities
    - Create `src/client/utils/validateFile.ts`:
      - `function validateFile(file: File): { valid: boolean; reason?: string }`
      - Supported types derived from `file.type` → mapped to `EvidenceStatus` type enum; max size 100,000,000 bytes
    - Create `src/client/utils/computeSHA256.ts`:
      - `async function computeSHA256(file: File): Promise<string>` using `crypto.subtle.digest('SHA-256', await file.arrayBuffer())`; returns lowercase hex string
    - All timestamps in client code use `new Date()`; no Firestore `Timestamp` import
    - _Requirements: 1.1, 1.2, 10.5_
    - _Design: §Upload Flow — Steps 1–2_
    - Dependencies: 1.1

  - [ ] 10.2 Implement three-branch idempotency check
    - Create `src/client/upload/idempotencyCheck.ts`
    - Export `async function checkIdempotency(evidenceId: string): Promise<IdempotencyResult>` with `IdempotencyResult` discriminated union covering `FRESH`, `COMPLETE_DUPLICATE`, `STALLED`, `CONCURRENT`, `TERMINAL`, `NETWORK_ERROR`
    - Fetch existing document with 1 retry on network error per Req 2.6
    - Branch A (no document): return `FRESH`
    - Branch B (status `available`): return `COMPLETE_DUPLICATE`
    - Branch C (status `uploading` or `processing`, `now - updatedAt > 300s`): return `STALLED`
    - Concurrent window (status `uploading` or `processing`, `now - updatedAt ≤ 300s`): return `CONCURRENT`
    - Terminal states (`failed`, `integrity_failed`, `encryption_failed`, `expired`): return `TERMINAL`
    - Requires explicit three-branch handling — two-branch patterns explicitly prohibited per Req 2.5
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
    - _Design: §Upload Flow — Step 3_
    - Dependencies: 1.1

  - [ ] 10.3 Implement Firestore document creation (fresh upload path)
    - Create `src/client/upload/createEvidenceDocument.ts`
    - Constructs the full `EvidenceDocument` shape per design §Upload Flow Step 4, with all timestamps as `new Date()`; `encryptionKeyRef: ''`; `encryptionIV: ''`; `retentionExpiresAt: null`; `chainOfCustody: []`
    - Calls `db.collection('evidence').doc(evidenceId).set(evidenceDoc)`
    - If `set()` throws → return error; no Storage upload is attempted; notify user
    - Firestore `Timestamp` class MUST NOT be imported in this file
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 10.5_
    - _Design: §Upload Flow — Step 4_
    - Dependencies: 1.1, 10.1, 10.2

  - [ ] 10.4 Implement Firebase Storage transfer with `reportUploadFailure` integration
    - Create `src/client/upload/storageTransfer.ts`
    - Calls `storageRef.put(file)`; on failure calls `functions.httpsCallable('reportUploadFailure')({ evidenceId })`
    - If `reportUploadFailure` returns `ALREADY_PROCESSING` → return `{ error: 'UPLOAD_IN_PROGRESS' }` (do not show user a hard failure)
    - Otherwise throw `UploadError` for the caller to surface
    - Evidence_Client NEVER writes directly to the Firestore evidence document after creation
    - _Requirements: 1.8, 6.2_
    - _Design: §Upload Flow — Step 5_
    - Dependencies: 10.3, 3.1

  - [ ] 10.5 Implement conditional resume transaction and `retriggerProcessing` integration
    - Create `src/client/upload/resumeUpload.ts`
    - Dual-condition transaction checking both `status` still `uploading`/`processing` AND `updatedAt` staleness > 300s at commit time
    - If either condition false at commit time → return `CONCURRENT_UPLOAD` error
    - On commit success → call `functions.httpsCallable('retriggerProcessing')({ evidenceId })`
    - If transaction aborts because status reached terminal state → return `TERMINAL_FAILURE`; user directed to create new evidence item
    - _Requirements: 2.3, 2.7_
    - _Design: §Race Condition Resolution — Additional Staleness Guard, Resume Mechanism_
    - Dependencies: 10.2, 4.1

  - [ ] 10.6 Implement `captureEvidence` orchestrator function
    - Create `src/client/upload/captureEvidence.ts`
    - Orchestrates: `validateFile` → `computeSHA256` → `checkIdempotency` → branch dispatch → `createEvidenceDocument` → `storageTransfer` (fresh path) / `resumeUpload` (stalled path)
    - Returns typed `UploadResult` for all branches and error conditions
    - _Requirements: 1.1–1.8, 2.1–2.7_
    - _Design: §Upload Flow — Client-Side Steps_
    - Dependencies: 10.1, 10.2, 10.3, 10.4, 10.5

  - [ ]* 10.7 Write unit tests for client upload flow
    - Test `validateFile`: boundary values (exactly 100 MB = valid, 100 MB + 1 byte = invalid), all 5 valid types, unsupported type
    - Test `checkIdempotency`: all three branches + concurrent + terminal + network error
    - Test `captureEvidence`: fresh upload success; complete duplicate returns success immediately; stalled > 300s triggers resume; Storage failure calls `reportUploadFailure`; Firestore creation failure prevents Storage transfer
    - _Requirements: 1.1, 1.2, 1.7, 2.1–2.7_
    - Dependencies: 10.6

- [ ] 11. Security Rules
  - [ ] 11.1 Implement Firestore security rules for the `evidence` collection
    - Write `firestore.rules` (or update existing)
    - `/evidence/{evidenceId}`:
      - `allow create`: `request.auth != null && request.resource.data.userId == request.auth.uid && request.resource.data.status == 'uploading'`
      - `allow read`: `request.auth != null && (resource.data.userId == request.auth.uid || isActiveGrantedContact(request.auth.uid, resource.data.userId))`
      - `allow update: if false` — no exceptions, no client carve-outs
      - `allow delete: if false`
    - `isActiveGrantedContact(uid, ownerId)` helper: checks `exists(/grantedContacts/$(ownerId)/contacts/$(uid))` AND `get(...).data.revoked != true`
    - Confirm the `status: 'failed'` carve-out from any prior draft is absent
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3_
    - _Design: §Firestore Security Rules Design_
    - Dependencies: none (references collection shape from 1.1)

  - [ ] 11.2 Implement Firebase Storage security rules for evidence files
    - Write `storage.rules` (or update existing)
    - `match /evidence/{evidenceId}/{fileName}`:
      - `allow read: if false` — all client reads denied; only Cloud Functions via Admin SDK
      - `allow write: if request.auth != null && request.auth.uid != null` — authenticated client initial upload only
    - _Requirements: 6.5_
    - _Design: §Firestore Security Rules Design — Firebase Storage Rules_
    - Dependencies: none

- [ ] 12. Property-Based Tests (fast-check)
  - [ ] 12.1 Set up fast-check test infrastructure and shared arbitraries
    - Install `fast-check` (exact version pinned in `package.json`)
    - Create `src/tests/property/arbitraries.ts` with all reusable generators:
      - `arbEvidenceType`, `arbValidFile`, `arbInvalidFile`, `arbEvidenceDocument`, `arbChainOfCustodyEntry`
      - `arbLegalHoldReason`, `arbInvalidLegalHoldReason`, `arbRetentionDays`, `arbStalenessSeconds`
    - All `arbEvidenceDocument` and `arbChainOfCustodyEntry` generators produce `Date` instances for timestamp fields — never `Timestamp`
    - Configure `{ numRuns: 100 }` globally or per-test
    - Tag format: `// Feature: evidence-trail, Property {N}: {property_text}`
    - _Design: §Testing Strategy_
    - Dependencies: 1.1

  - [ ] 12.2 Write property tests for Properties 1 and 2 (file validation and SHA-256)
    - P1: `validateFile` returns `valid: true` iff type in valid set AND size ≤ 100,000,000 bytes
    - P2: `computeSHA256` is deterministic — same bytes always produce same hex string; matches reference crypto implementation
    - _Requirements: 1.1, 1.2, 3.1_
    - _Design: Properties 1–2_
    - Dependencies: 12.1, 10.1

  - [ ] 12.3 Write property tests for Properties 3 and 4 (field completeness and upload idempotency)
    - P3: any valid file + metadata combination produces a Firestore document containing all required fields non-null
    - P4: any sequence of `captureEvidence` calls after status `available` returns success immediately without re-uploading
    - _Requirements: 1.4, 2.1, 2.2, 2.5, 11.2_
    - _Design: Properties 3–4_
    - Dependencies: 12.1, 10.3, 10.6

  - [ ] 12.4 Write property tests for Properties 5 and 18 (staleness branch selection and race safety)
    - P5: for any staleness value, `checkIdempotency` selects resume path iff staleness > 300s, concurrent error iff ≤ 300s
    - P18: for any stalled document, exactly one of (client resume, Cloud Function `failed`) commits; neither commits twice; within 5 minutes status leaves `uploading`/`processing`
    - _Requirements: 2.3, 2.4, 2.7, 11.5_
    - _Design: Properties 5, 18_
    - Dependencies: 12.1, 10.2, 2.1, 4.1

  - [ ] 12.5 Write property tests for Properties 6 and 7 (integrity verification and snapshot determinism)
    - P6: `onEvidenceCreate` sets `integrity_failed` iff server SHA-256 ≠ document `sha256Hash`; when equal, pipeline proceeds
    - P7: `computeIntegritySnapshot` is deterministic — same immutable field values always produce same string
    - _Requirements: 3.1, 3.2, 3.3_
    - _Design: Properties 6–7_
    - Dependencies: 12.1, 1.3, 2.2

  - [ ] 12.6 Write property tests for Properties 8 and 11 (encryption before availability and complete client write exclusion)
    - P8: for any evidence document D, `status === 'available'` implies non-empty `encryptionKeyRef`, 24-char base64 `encryptionIV`, and Storage object contains only ciphertext
    - P11: any post-creation client write to any field on any evidence document is rejected with an observable error — no write commits
    - _Requirements: 4.1, 4.2, 6.2, 6.4, 11.6, 11.7_
    - _Design: Properties 8, 11_
    - Dependencies: 12.1, 2.3, 11.1

  - [ ] 12.7 Write property tests for Properties 9 and 10 (chain-of-custody monotonicity and entry completeness)
    - P9: `chainOfCustody.length` is non-decreasing; after N append operations, length increases by exactly N
    - P10: after any custody-appending operation, an entry exists with correct `action`, `performedBy`, `timestamp instanceof Date`, and `evidenceId`
    - _Requirements: 5.3, 5.7, 5.1, 5.2_
    - _Design: Properties 9–10_
    - Dependencies: 12.1, 1.4

  - [ ] 12.8 Write property tests for Properties 12 and 16 (access exclusivity and no partial export)
    - P12: read access granted iff uid matches `userId` OR active GrantedContact exists; no other condition grants access
    - P16: `generateLegalExport` returns either a complete PDF for all incident files or an error — never a partial package
    - _Requirements: 7.1, 7.2, 7.3, 9.6_
    - _Design: Properties 12, 16_
    - Dependencies: 12.1, 11.1, 6.3

  - [ ] 12.9 Write property tests for Properties 13, 14, and 15 (retention arithmetic, legal hold preservation, legalHoldReason validation)
    - P13: for any valid retention period R and createdAt T, `retentionExpiresAt = T + R × 86,400,000ms` exactly
    - P14: `processEvidenceExpiry` never transitions `legal_hold` documents to `expired` regardless of `retentionExpiresAt`
    - P15: `setLegalHold` accepts reasons with `length ∈ [1, 1000]`, rejects empty and > 1000 chars
    - _Requirements: 8.1, 8.3, 8.5_
    - _Design: Properties 13–15_
    - Dependencies: 12.1, 1.7, 7.1, 8.1

  - [ ] 12.10 Write property tests for Properties 17 (timestamp type invariant)
    - P17: for any evidence document or custody entry read from Firestore, all timestamp fields are `instanceof Date`; none are Firestore `Timestamp`, `null` (for non-nullable fields), `undefined`, or other type
    - _Requirements: 10.1, 10.2, 10.3_
    - _Design: Property 17_
    - Dependencies: 12.1, 1.2

- [ ] 13. Integration Tests (Firebase Emulator Suite)
  - [ ] 13.1 Set up Firebase Emulator test environment
    - Configure `firebase.json` / `emulator.json` for Firestore, Storage, Functions, Auth emulators
    - Set `FUNCTIONS_EMULATOR=true` in test environment to activate `KMSMock`
    - Create shared test helpers: seed Firestore, create Auth users, upload test files to Storage emulator
    - Confirm all test fixtures use `new Date(...)` for timestamps — no `Timestamp.fromDate()`
    - _Requirements: 4.4, 10.5_
    - _Design: §Testing Strategy — Test Environment Setup_
    - Dependencies: all implementation tasks (1–11)

  - [ ] 13.2 Write integration tests for end-to-end upload flow
    - Test fresh upload: Firestore document created → Storage file uploaded → `onEvidenceCreate` runs → `status: 'available'`, `chainOfCustody` has `uploaded` entry, Storage object contains ciphertext
    - Test Storage failure path: `reportUploadFailure` called → `status: 'failed'` with custody entry
    - Test stalled resume: document left in `uploading` > 300s → `retriggerProcessing` resumes pipeline → `status: 'available'`
    - Test race: `reportUploadFailure` races `onEvidenceCreate` step 1 → exactly one commits
    - _Requirements: 1.3, 1.8, 2.3, 2.7, 11.3, 11.4_
    - Dependencies: 13.1

  - [ ] 13.3 Write integration tests for legal export flow
    - Test: authenticated owner exports incident → PDF returned, `exported` entries appended to all items
    - Test: unauthorized caller → 403, no PDF
    - Test: missing evidence → 404
    - Test: one Storage file inaccessible → entire export rejected, no partial PDF
    - Test: expired evidence in export → retention-expired notice present
    - _Requirements: 9.1–9.7_
    - Dependencies: 13.1, 6.3

  - [ ] 13.4 Write integration tests for expiry flow
    - Test: `processEvidenceExpiry` transitions eligible documents to `expired` with custody entries
    - Test: `legal_hold` document not expired
    - Test: invalid retention config → aborts run
    - _Requirements: 8.2, 8.3, 8.7_
    - Dependencies: 13.1, 7.1

  - [ ] 13.5 Write Firestore and Storage security rule integration tests
    - Use Firebase Emulator rules testing library
    - Firestore `evidence` collection: create (valid) → allowed; update → denied (`allow update: if false`); delete → denied; read by owner → allowed; read by active GrantedContact → allowed; read by unrelated user → denied
    - Storage evidence files: client read → denied; client write (authenticated) → allowed
    - Confirm old `status: 'failed'` client carve-out is absent and would be denied
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3_
    - Dependencies: 13.1, 11.1, 11.2

- [ ] 14. Final Checkpoint — Ensure all tests pass
  - Ensure all tests pass (unit, property-based, integration), ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP pass; the core pipeline will still be correct without them.
- `FieldValue.arrayUnion()` is prohibited everywhere in this codebase. The only permitted custody append pattern is the read-spread-write transaction via `appendCustodyEntry`.
- All timestamps throughout the system (client, functions, fixtures) use `new Date()`. Firestore `Timestamp` is never imported in evidence-related code.
- `KMSMock` is activated automatically when `FUNCTIONS_EMULATOR=true` or `NODE_ENV=test`. No Cloud Function should call `createKMSClient()` and receive the real `CloudKMSClient` in any test.
- Phase 1 (tasks 1.1–1.7) must be complete before any work in phases 2–10 begins. Tasks 1.1–1.4 must all be done before any Cloud Function that appends custody entries; task 1.5 must be done before any Cloud Function that uses encryption.
- Each task assumes all context documents (requirements.md, design.md) are available during implementation.
- Checkpoints at tasks 9 and 14 are where to surface questions before proceeding to the next phase.

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.5", "1.6", "1.7"] },
    { "id": 1, "tasks": ["1.2", "1.3", "12.1"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["2.1", "3.1", "7.1", "8.1", "8.2", "8.3", "8.4", "8.5", "10.1", "11.1", "11.2"] },
    { "id": 4, "tasks": ["2.2", "10.2", "12.10"] },
    { "id": 5, "tasks": ["2.3", "10.3", "12.7"] },
    { "id": 6, "tasks": ["2.4", "6.1", "10.4"] },
    { "id": 7, "tasks": ["2.5", "3.2", "4.1", "6.2", "10.5", "12.2", "12.3"] },
    { "id": 8, "tasks": ["4.2", "5.1", "6.3", "10.6", "12.4", "12.5"] },
    { "id": 9, "tasks": ["5.2", "6.4", "7.2", "8.6", "10.7", "12.6", "12.8", "12.9"] },
    { "id": 10, "tasks": ["13.1"] },
    { "id": 11, "tasks": ["13.2", "13.3", "13.4", "13.5"] }
  ]
}
```
