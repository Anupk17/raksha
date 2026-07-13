# Requirements Document

## Introduction

The Evidence Trail system is a core component of the RAKSHA women's safety platform. It enables users to capture, securely store, and manage tamper-proof digital evidence of harassment incidents. Each piece of evidence is hashed client-side before upload, encrypted at rest via Cloud KMS, and tracked through an immutable chain-of-custody log. The system supports legal-grade export of evidence packages and enforces strict access control so only the owning user and explicitly granted contacts can access evidence.

This document incorporates hard-won engineering guardrails discovered during a prior implementation attempt. Those guardrails are encoded as first-class requirements — not implementation notes — because violating them causes data corruption, silent deduplication of custody log entries, or broken deserialization at runtime.

---

## Glossary

- **Evidence_System**: The full Evidence Trail subsystem of RAKSHA, encompassing client logic, Cloud Functions, Firestore rules, and Firebase Storage rules.
- **Evidence_Client**: The React/TypeScript PWA code responsible for computing hashes, preparing upload metadata, and initiating evidence documents.
- **Evidence_Store**: The Firestore `/evidence/{evidenceId}` collection.
- **Storage_Bucket**: The Firebase Storage bucket where encrypted evidence files are persisted.
- **Cloud_Function**: A Firebase Cloud Function running with Admin SDK privileges.
- **KMS_Client**: The injectable Cloud KMS abstraction responsible for key management and encryption-key generation.
- **KMS_Mock**: A test-environment substitute for KMS_Client that performs pass-through or local encryption without calling the real Cloud KMS API.
- **Chain_Of_Custody_Log**: The append-only array of `ChainOfCustodyEntry` records stored on each evidence document.
- **Custody_Entry**: A single record in the Chain_Of_Custody_Log describing one action taken on an evidence item.
- **Legal_Export**: A court-ready PDF package containing evidence files, metadata, chain-of-custody log, and an integrity verification report.
- **Legal_Hold**: A status flag indicating evidence must not expire and must be preserved for legal proceedings.
- **Retention_Policy**: The configurable period after which evidence transitions to `expired` status unless under Legal_Hold.
- **SHA256_Hash**: The SHA-256 digest of an evidence file, computed before upload and verified after processing.
- **Integrity_Snapshot**: A SHA-256 digest of the evidence document's full state at the moment a Custody_Entry is recorded.
- **Owner**: The user identified by `userId` on an evidence document.
- **Granted_Contact**: A user explicitly authorized by the Owner to read evidence (e.g., a legal representative or support contact).
- **Upload_Flow**: The end-to-end sequence of client-side hash computation, Firestore document creation, file upload to Storage_Bucket, and Cloud_Function processing.
- **Stalled_Document**: An evidence document that exists in Firestore with status `uploading` or `processing`, indicating a prior Upload_Flow started but did not complete.

---

## Requirements

### Requirement 1: Evidence Capture and Upload Initiation

**User Story:** As a RAKSHA user, I want to attach photo, video, audio, screenshot, or document files to an incident report, so that I have a verifiable record of the harassment I experienced.

#### Acceptance Criteria

1. THE Evidence_Client SHALL accept files of type `photo`, `video`, `audio`, `screenshot`, and `document` for upload, where each file does not exceed 100 MB; IF a selected file exceeds 100 MB or has an unsupported file type, THEN THE Evidence_Client SHALL reject the file with an error message indicating the reason and SHALL NOT initiate an upload.
2. WHEN a user selects a file for upload, THE Evidence_Client SHALL compute the SHA-256 hash of the raw file bytes on-device before transmitting any data to the server.
3. WHEN a user initiates an upload, THE Evidence_Client SHALL create an evidence document in the Evidence_Store with status `uploading` before transferring the file to the Storage_Bucket.
4. THE Evidence_Client SHALL record `originalFilename`, `mimeType`, `sizeBytes`, `sha256Hash`, `incidentId`, `userId`, `type`, `capturedAt`, `deviceInfo`, and `incidentContext` on the evidence document at creation time, where `type` is one of `photo`, `video`, `audio`, `screenshot`, or `document`.
5. WHEN a location hash is available, THE Evidence_Client SHALL record a hashed GPS value (not raw coordinates) in the `locationHash` field of the evidence document metadata.
6. THE Evidence_Client SHALL set `createdAt` and `updatedAt` on the evidence document using JavaScript native `Date` objects — Firestore `Timestamp` objects SHALL NOT be used for any timestamp field on an evidence document, including fields that are not explicitly listed in this document.
7. IF the Evidence_Store document creation fails, THEN THE Evidence_Client SHALL not initiate any file transfer to the Storage_Bucket, SHALL ensure no partial evidence document is persisted, and SHALL notify the user with an error message indicating the upload could not be started.
8. IF the Storage_Bucket file transfer fails after the evidence document has been created, THEN THE Evidence_Client SHALL call the `reportUploadFailure` Cloud_Function with the `evidenceId`, and SHALL notify the user with an error message indicating the upload did not complete — THE Evidence_Client SHALL NOT write directly to the evidence document's `status` field.

---

### Requirement 2: Idempotent Upload with Three-Branch Resume Logic

**User Story:** As a RAKSHA user, I want interrupted uploads to resume correctly rather than creating duplicate evidence records, so that my evidence log remains accurate and clean.

#### Acceptance Criteria

1. WHEN the Evidence_Client initiates an upload and no evidence document exists for the given `evidenceId`, THE Evidence_Client SHALL proceed with a fresh upload (Fresh branch).
2. WHEN the Evidence_Client initiates an upload and an evidence document already exists with status `available`, THE Evidence_Client SHALL return a success result immediately and SHALL NOT re-upload the file or create a new document (Complete Duplicate branch).
3. WHEN the Evidence_Client initiates an upload and an evidence document already exists with status `uploading` or `processing` and the document's `updatedAt` timestamp is more than 300 seconds before the current time, THE Evidence_Client SHALL attempt to resume the Upload_Flow by performing a conditional Firestore transaction that reads the current status and proceeds only if the status is still `uploading` or `processing` at commit time — if the transaction aborts because the status has changed (e.g., to `failed` by a concurrent Cloud_Function), THE Evidence_Client SHALL NOT proceed with the upload and SHALL treat the outcome according to criterion 7 (Stalled_Document branch).
4. IF the Evidence_Client detects an evidence document with status `uploading` or `processing` whose `updatedAt` timestamp is within 300 seconds of the current time, THEN THE Evidence_Client SHALL return an error result to the caller indicating a concurrent upload is in progress and SHALL NOT create a new document.
5. THE Evidence_Client SHALL distinguish all three branches explicitly — a two-branch "check if exists, skip if found" pattern is insufficient and SHALL NOT be used.
6. IF the Evidence_Client cannot determine the current document status after at least 1 retry attempt due to a network error, THEN THE Evidence_Client SHALL return an error result to the caller and SHALL NOT proceed with a fresh upload.
7. IF the Evidence_Client's resume transaction (criterion 3) aborts because the document's status was concurrently changed to `failed` by a Cloud_Function error-transition, THEN THE Evidence_Client SHALL return an error result to the caller indicating the evidence item reached a terminal failure state, and SHALL NOT initiate a fresh upload for the same `evidenceId` — the user must be directed to create a new evidence item.

---

### Requirement 3: Tamper-Proof Integrity Verification

**User Story:** As a RAKSHA user, I want each piece of evidence to have its integrity verifiable at any time, so that I can prove in legal proceedings that files have not been altered since capture.

#### Acceptance Criteria

1. WHEN a new evidence document is created, THE Cloud_Function `onEvidenceCreate` SHALL re-compute the SHA-256 hash over the raw bytes of the uploaded file in Firebase Storage and compare it to the `sha256Hash` field recorded by the Evidence_Client.
2. IF the server-side computed hash does not match the client-recorded `sha256Hash`, THEN THE Cloud_Function SHALL set the evidence document status to `integrity_failed`, record a Custody_Entry with action `status_changed` and metadata fields containing both the expected hash value and the computed hash value, and SHALL NOT set the evidence document status to `available`.
3. WHEN a Custody_Entry is appended to the Chain_Of_Custody_Log, THE Cloud_Function SHALL compute an `integritySnapshot` SHA-256 digest over the deterministic serialization of the evidence document's immutable fields (`evidenceId`, `incidentId`, `userId`, `sha256Hash`, `originalFilename`, `mimeType`, `sizeBytes`, `createdAt`) sorted in lexicographic field-name order, and store it on the Custody_Entry.
4. THE Evidence_System SHALL preserve the `sha256Hash` field as immutable after initial creation — any component that attempts to write a different value to `sha256Hash` after document creation SHALL have that write rejected, and the rejection SHALL be observable as a security-rule denial or a thrown error.
5. IF the Cloud_Function `onEvidenceCreate` encounters a transient error while performing hash verification (e.g., Storage read failure, timeout), THEN THE Cloud_Function SHALL NOT set the evidence document status to `available`, and SHALL retry the verification operation up to 3 times before setting status to `integrity_failed` and recording a Custody_Entry with the error details.

---

### Requirement 4: Encryption at Rest

**User Story:** As a RAKSHA user, I want my evidence files to be encrypted before storage, so that they cannot be read by unauthorized parties even if storage infrastructure is compromised.

#### Acceptance Criteria

1. WHEN a new evidence file is uploaded to the Storage_Bucket, THE Cloud_Function `onEvidenceCreate` SHALL encrypt the file bytes and overwrite the stored object with the encrypted bytes before the evidence document status permits any read or download access.
2. THE Cloud_Function SHALL store the Cloud KMS key resource name in `encryptionKeyRef` and the 128-bit AES initialization vector encoded as a 24-character base64 string in `encryptionIV` on the evidence document.
3. THE KMS_Client SHALL be implemented behind an injectable interface so that it can be replaced with a KMS_Mock in local and test environments.
4. WHERE the Firebase Emulator Suite is active, THE Evidence_System SHALL use the KMS_Mock in place of the real KMS_Client — the real Cloud KMS API SHALL NOT be called from test or emulator environments. This prohibition applies to both test environments and emulator environments.
5. THE KMS_Client interface SHALL be defined and injected from the start of implementation — retrofitting it after the fact is explicitly prohibited by this requirement.
6. IF the encryption operation fails for any reason, THEN THE Cloud_Function SHALL set the evidence document status to `encryption_failed`, ensure no unencrypted file bytes remain accessible in the Storage_Bucket, and return an error response indicating the encryption failure.

---

### Requirement 5: Immutable Chain-of-Custody Log

**User Story:** As a RAKSHA user and as a legal representative, I want a complete, tamper-evident audit log of every action taken on each piece of evidence, so that chain of custody is provable in legal proceedings.

#### Acceptance Criteria

1. THE Evidence_System SHALL record a Custody_Entry for each of the following actions: `uploaded`, `viewed`, `shared`, `exported`, `legal_hold_set`, `legal_hold_released`, `status_changed`.
2. WHEN a Custody_Entry is appended to the Chain_Of_Custody_Log, every Custody_Entry SHALL contain the fields `action`, `performedBy` (userId or `system` or `cloud_function`), `timestamp` (native Date), and `evidenceId`.
3. WHEN a Custody_Entry is appended to the Chain_Of_Custody_Log, THE Evidence_System SHALL guarantee that no two concurrent append operations result in fewer total entries than the number of operations performed — the atomicity of each append SHALL be observable by reading the log after all operations complete.
4. THE Evidence_Client SHALL NOT write to the `chainOfCustody` array — all Chain_Of_Custody_Log appends SHALL be performed exclusively by Cloud_Functions using the Firebase Admin SDK.
5. IF a Chain_Of_Custody_Log append operation fails, THEN THE Cloud_Function SHALL reject the triggering operation (e.g., status transition, view event), SHALL NOT commit a partial state where the operation succeeded but the log entry was not recorded, and SHALL return an error response to the caller.
6. WHEN evidence is viewed by the Owner or a Granted_Contact, THE Cloud_Function SHALL append a `viewed` Custody_Entry recording the `performedBy` userId and the timestamp within 5 seconds of the view event being processed.
7. THE Chain_Of_Custody_Log SHALL be append-only — no component SHALL delete or modify existing entries.

---

### Requirement 6: Write-Once Client Security Model

**User Story:** As a RAKSHA platform operator, I want Firestore security rules to enforce that clients can only create evidence documents and cannot modify them afterwards, so that evidence integrity cannot be compromised through client-side attacks.

#### Acceptance Criteria

1. IF a user holds a valid Firebase Auth identity, THEN THE Evidence_Store Firestore security rules SHALL allow that user to create a new evidence document.
2. THE Evidence_Store Firestore security rules SHALL deny ALL update operations from the client SDK on existing evidence documents, regardless of the authenticated state of the requester — there are no permitted post-creation client-side writes to any field, including `status`.
3. THE Evidence_Store Firestore security rules SHALL deny delete operations from the client SDK on evidence documents, regardless of the authenticated state of the requester.
4. THE Evidence_Store Firestore security rules SHALL deny client SDK write access to ALL fields on existing evidence documents — the document is fully write-once from the client; every post-creation field update is performed exclusively by Cloud_Functions via Admin SDK.
5. THE Storage_Bucket security rules SHALL deny any read operation (including content reads and metadata reads) initiated directly by the client SDK on evidence files.
6. WHEN a Cloud_Function serves an evidence file to a requestor, THE Cloud_Function SHALL verify that the requestor holds a valid Firebase Auth identity before transmitting any file bytes or metadata.

---

### Requirement 7: Access Control

**User Story:** As a RAKSHA user, I want only myself and contacts I explicitly authorize to be able to access my evidence, so that my sensitive files are not visible to other users or RAKSHA staff.

#### Acceptance Criteria

1. IF the requesting user's `uid` matches the evidence document's `userId` field, THEN THE Evidence_Store security rules SHALL allow that user read access to the evidence document and its associated Storage files (Owner access).
2. IF an active (non-revoked) Granted_Contact relationship exists between the requesting user and the evidence document's Owner, THEN THE Evidence_Store security rules SHALL allow that user read-only access to the evidence document and its associated Storage files.
3. IF the requesting user is neither the Owner nor holds an active Granted_Contact relationship for the evidence document, THEN THE Evidence_Store security rules SHALL deny read access to the evidence document and its associated Storage files, including for RAKSHA platform operators.
4. WHEN an Owner grants access to a contact, THE Evidence_System SHALL record a Custody_Entry in the Chain_Of_Custody_Log with action type `granted`, the Owner's uid, the contact's uid, and an ISO 8601 timestamp.
5. WHEN an Owner revokes access from a contact who currently holds an active Granted_Contact relationship, THE Evidence_System SHALL record a Custody_Entry in the Chain_Of_Custody_Log with action type `revoked`, the Owner's uid, the contact's uid, and an ISO 8601 timestamp.
6. THE Evidence_Store security rules SHALL deny write and delete access to evidence documents and their associated Storage files for all Granted_Contacts.

---

### Requirement 8: Retention Policy and Expiry

**User Story:** As a RAKSHA user, I want evidence to be retained for a configurable period and then automatically expired unless I have flagged it for legal hold, so that storage is not used indefinitely for resolved incidents.

#### Acceptance Criteria

1. WHEN a new evidence document is created, THE Evidence_System SHALL set `retentionExpiresAt` to a date calculated by adding the globally configured retention period (in whole days, between 1 and 3650 inclusive) to the `createdAt` timestamp.
2. WHEN the scheduled Cloud_Function `processEvidenceExpiry` runs, THE Cloud_Function SHALL evaluate each evidence document using the server's current time at the moment of invocation; for each document whose `retentionExpiresAt` is before that time and whose status is not `legal_hold`, THE Cloud_Function SHALL transition the document status to `expired`; IF any individual document transition fails, THE Cloud_Function SHALL log the failure and continue processing remaining documents.
3. WHILE an evidence document has status `legal_hold`, THE Cloud_Function `processEvidenceExpiry` SHALL NOT transition that document to `expired`.
4. WHEN an evidence document is transitioned to `expired`, THE Cloud_Function SHALL append a `status_changed` Custody_Entry to the Chain_Of_Custody_Log with `performedBy` set to `cloud_function`, a native `Date` timestamp, and metadata fields recording the prior status and the new `expired` status.
5. WHEN an Owner sets a Legal_Hold on an evidence document that is not already in `legal_hold` status, THE Evidence_System SHALL set status to `legal_hold`, populate `legalHoldReason` with a non-empty string of at most 1000 characters, and record a `legal_hold_set` Custody_Entry; IF `legalHoldReason` is empty or exceeds 1000 characters, THE Evidence_System SHALL reject the request with a validation error.
6. WHEN an Owner releases a Legal_Hold on an evidence document that is currently in `legal_hold` status, THE Evidence_System SHALL set `retentionExpiresAt` to a date calculated by adding the globally configured retention period to the current server time, and SHALL record a `legal_hold_released` Custody_Entry; IF the document is not in `legal_hold` status, THE Evidence_System SHALL reject the release request with an error.
7. THE Evidence_System SHALL enforce that the globally configured retention period is a whole number of days between 1 and 3650 inclusive; IF a configuration value outside this range is supplied, THE Evidence_System SHALL reject the configuration at startup and SHALL NOT process any evidence expiry until a valid value is provided.

---

### Requirement 9: Legal Export

**User Story:** As a RAKSHA user, I want to generate a court-ready export package of my evidence, so that I can submit it to law enforcement or legal proceedings with proof of integrity and chain of custody.

#### Acceptance Criteria

1. WHEN an Owner or Granted_Contact calls the `generateLegalExport` Cloud_Function with a valid `incidentId`, THE Cloud_Function SHALL assemble a Legal_Export PDF package scoped to that incident.
2. THE Legal_Export package SHALL include: all evidence files associated with the requested `incidentId`, metadata for each evidence item (`type`, `capturedAt`, `deviceInfo`, `locationHash`, `mimeType`, `sizeBytes`), the full Chain_Of_Custody_Log for each evidence item, and an integrity verification report showing the `sha256Hash` and current status from the set (`uploading`, `processing`, `available`, `expired`, `legal_hold`, `failed`, `integrity_failed`, `encryption_failed`).
3. WHEN a Legal_Export is assembled, THE Cloud_Function SHALL append an `exported` Custody_Entry to the Chain_Of_Custody_Log of each evidence item included in the package, using a Firestore transaction consistent with Requirement 5.
4. IF the requesting user is neither the Owner nor holds an active Granted_Contact relationship for the incident's evidence, THEN THE Cloud_Function SHALL reject the export request immediately with an authorization error and SHALL NOT assemble any portion of the Legal_Export package.
5. WHEN a Legal_Export is generated for evidence with status `expired`, THE Cloud_Function SHALL include a notice in the integrity verification report indicating the evidence has passed its retention period and SHALL record the `retentionExpiresAt` value in that notice.
6. IF any evidence file associated with the requested `incidentId` is inaccessible from the Storage_Bucket during assembly, THEN THE Cloud_Function SHALL reject the entire export request with an error identifying the inaccessible file(s) and SHALL NOT produce a partial Legal_Export package.
7. IF the requested `incidentId` has no associated evidence documents, THEN THE Cloud_Function SHALL reject the export request with a descriptive error indicating no evidence is available and SHALL NOT produce an empty package.

---

### Requirement 10: Timestamp Consistency Across All Evidence Operations

**User Story:** As a RAKSHA platform engineer, I want all timestamp fields on evidence documents and custody entries to use JavaScript native Date objects consistently, so that deserialization from Firestore does not fail across SDK versions and environments.

#### Acceptance Criteria

1. THE Evidence_System SHALL store all timestamp fields — including `createdAt`, `updatedAt`, `capturedAt`, `retentionExpiresAt`, and `ChainOfCustodyEntry.timestamp` — as JavaScript native `Date` objects.
2. THE Evidence_System SHALL NOT store any timestamp field as a Firestore `Timestamp` object.
3. WHEN any Cloud_Function reads an evidence document from Firestore, THE Cloud_Function SHALL deserialize timestamp fields as native `Date` objects.
4. IF deserialization of any timestamp field fails for any reason (SDK version incompatibility, data corruption, unexpected type), THEN THE Cloud_Function SHALL abort the current operation, log the field name and failure reason, and return an error response that identifies the affected field — the Cloud_Function SHALL NOT silently substitute null, undefined, or an incorrect type for the failed field.
5. THE Evidence_System SHALL apply the native `Date` requirement uniformly across the Evidence_Client, all Cloud_Functions, and all test fixtures — no component SHALL deviate from this convention.

---

### Requirement 11: Evidence Status Lifecycle

**User Story:** As a RAKSHA platform engineer, I want evidence documents to transition through a well-defined status lifecycle, so that the state of every evidence item is unambiguous at all times.

#### Acceptance Criteria

1. THE Evidence_System SHALL define exactly six valid status values for evidence documents: `uploading`, `processing`, `available`, `expired`, `legal_hold`, `failed`.
2. WHEN an evidence document is first created by the Evidence_Client, THE Evidence_Client SHALL set status to `uploading`.
3. WHEN the Cloud_Function `onEvidenceCreate` begins processing an evidence document, THE Cloud_Function SHALL set status to `processing`.
4. WHEN the Cloud_Function `onEvidenceCreate` completes all processing successfully, THE Cloud_Function SHALL set status to `available`.
5. IF the Cloud_Function `onEvidenceCreate` encounters an unrecoverable error, THEN THE Cloud_Function SHALL perform a conditional Firestore transaction that sets status to `failed` and records a `status_changed` Custody_Entry with the error details only if the document's status is still `uploading` or `processing` at commit time; this conditional write SHALL be completed within 5 minutes of the error occurring; IF the transaction aborts because the status has already changed (e.g., a concurrent Evidence_Client resume succeeded and advanced the status), THE Cloud_Function SHALL log the abort and take no further action on that document — the resume path takes precedence; THE Cloud_Function SHALL NOT leave the document in `uploading` or `processing` indefinitely.
6. THE Evidence_System SHALL NOT permit any client-initiated status changes after initial document creation — this prohibition applies to all status transitions, including attempts to set the same status value that is already present on the document.
7. IF the Evidence_Client attempts to update the `status` field of an existing evidence document, THEN THE Evidence_Store Firestore security rules SHALL deny the write and THE Evidence_Client SHALL receive an observable rejection (a security-rule denial error or an equivalent thrown error).
