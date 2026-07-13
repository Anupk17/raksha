/**
 * Core TypeScript interfaces for the RAKSHA Evidence Trail system.
 *
 * TIMESTAMP RULE: All Date fields throughout this system use JavaScript's
 * native Date class. Firestore Timestamp is NEVER used in any evidence-related
 * code. Violations cause deserialization failures at runtime.
 */

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Exactly eight valid status values for evidence documents.
 * Client sets 'uploading' on creation; all subsequent transitions are
 * performed exclusively by Cloud Functions via Admin SDK.
 *
 * Requirements: 11.1 (design lists integrity_failed and encryption_failed as
 * additional terminal states beyond the six in Req 11.1 — both are included).
 */
export type EvidenceStatus =
  | "uploading"
  | "processing"
  | "available"
  | "expired"
  | "legal_hold"
  | "failed"
  | "integrity_failed"
  | "encryption_failed";

// ---------------------------------------------------------------------------
// Chain of Custody
// ---------------------------------------------------------------------------

/**
 * Nine valid custody action types.
 * 'granted' and 'revoked' replace the ambiguous 'shared' used in earlier
 * drafts to make grant and revoke distinguishable in the audit log.
 */
export type CustodyAction =
  | "uploaded"
  | "viewed"
  | "shared"
  | "exported"
  | "legal_hold_set"
  | "legal_hold_released"
  | "status_changed"
  | "granted"
  | "revoked";

/**
 * A single immutable entry in the chain-of-custody log.
 *
 * CRITICAL: timestamp MUST be a native Date. FieldValue.arrayUnion() with
 * objects containing Date fields silently deduplicates entries — use the
 * read-spread-write pattern via appendCustodyEntry() instead.
 */
export interface ChainOfCustodyEntry {
  /** The action that occurred. */
  action: CustodyAction;
  /**
   * Who performed the action.
   * userId | 'system' | 'cloud_function'
   */
  performedBy: string;
  /** Native Date — NEVER Firestore Timestamp. */
  timestamp: Date;
  /** evidenceId of the document this entry belongs to. */
  evidenceId: string;
  /** Optional key-value context (reason, hash values, prior status, etc.). */
  metadata: Record<string, string> | null;
  /**
   * SHA-256 of the deterministic JSON of the document's immutable fields
   * at the moment this entry was recorded. Null only on error paths where
   * the document state cannot be reliably serialized.
   */
  integritySnapshot: string | null;
}

// ---------------------------------------------------------------------------
// Evidence Metadata (nested inside EvidenceDocument)
// ---------------------------------------------------------------------------

export interface EvidenceMetadata {
  /** When the evidence was originally captured (not when uploaded). Native Date. */
  capturedAt: Date;
  /** Opaque device info string (OS, browser, etc.). */
  deviceInfo: string;
  /**
   * One-way hash of GPS coordinates. Raw coordinates are never stored.
   * Null if location was not available at capture time.
   */
  locationHash: string | null;
  /** Free-text description of the incident context. Null if not provided. */
  incidentContext: string | null;
}

// ---------------------------------------------------------------------------
// Evidence Document
// ---------------------------------------------------------------------------

/**
 * Canonical shape of a Firestore document at /evidence/{evidenceId}.
 *
 * Write-once from the client: the client may only create this document.
 * All post-creation field updates (status, chainOfCustody, encryptionKeyRef,
 * encryptionIV, updatedAt, retentionExpiresAt) are performed exclusively by
 * Cloud Functions via Admin SDK.
 */
export interface EvidenceDocument {
  evidenceId: string;
  /** FK → /incidents/{incidentId} */
  incidentId: string;
  /** FK → /users/{userId} — owner of this evidence item. */
  userId: string;
  type: "photo" | "video" | "audio" | "screenshot" | "document";
  /** Firebase Storage path where the (encrypted) file is stored. */
  storageRef: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * SHA-256 hex digest of the raw file bytes, computed on-device before upload.
   * Immutable after creation — security rules must reject writes to this field.
   */
  sha256Hash: string;
  /**
   * Cloud KMS key resource name for the encrypted DEK.
   * Empty string until set by onEvidenceCreate.
   */
  encryptionKeyRef: string;
  /**
   * 128-bit AES-GCM initialization vector, base64-encoded as a 24-char string.
   * Empty string until set by onEvidenceCreate.
   */
  encryptionIV: string;
  status: EvidenceStatus;
  /**
   * When this evidence expires under the configured retention policy.
   * Null until set by onEvidenceCreate. Date type — never Firestore Timestamp.
   */
  retentionExpiresAt: Date | null;
  /**
   * Non-empty reason string (1–1000 chars) when status is 'legal_hold'.
   * Null otherwise.
   */
  legalHoldReason: string | null;
  /**
   * Append-only array. Never written by the client.
   * All appends go through appendCustodyEntry() — never FieldValue.arrayUnion().
   */
  chainOfCustody: ChainOfCustodyEntry[];
  /** Native Date — NEVER Firestore Timestamp. */
  createdAt: Date;
  /** Native Date — NEVER Firestore Timestamp. */
  updatedAt: Date;
  metadata: EvidenceMetadata;
}

// ---------------------------------------------------------------------------
// Granted Contact (sub-collection: /grantedContacts/{ownerId}/contacts/{uid})
// ---------------------------------------------------------------------------

export interface GrantedContact {
  contactUid: string;
  ownerId: string;
  /** Native Date — NEVER Firestore Timestamp. */
  grantedAt: Date;
  revoked: boolean;
  /** Native Date if revoked, null otherwise. NEVER Firestore Timestamp. */
  revokedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Upload result types (used by client-side upload flow)
// ---------------------------------------------------------------------------

export type UploadResultSuccess = {
  success: true;
  evidenceId: string;
  /** True when the Complete Duplicate branch was taken. */
  idempotent?: boolean;
};

export type UploadResultError = {
  success: false;
  error:
    | "NETWORK_ERROR"
    | "CONCURRENT_UPLOAD"
    | "TERMINAL_FAILURE"
    | "UPLOAD_IN_PROGRESS"
    | "VALIDATION_ERROR"
    | "FIRESTORE_CREATE_FAILED"
    | "STORAGE_TRANSFER_FAILED";
  message: string;
};

export type UploadResult = UploadResultSuccess | UploadResultError;

// ---------------------------------------------------------------------------
// Idempotency check result (used by checkIdempotency())
// ---------------------------------------------------------------------------

export type IdempotencyResult =
  | { branch: "FRESH" }
  | { branch: "COMPLETE_DUPLICATE" }
  | { branch: "STALLED" }
  | { branch: "CONCURRENT" }
  | { branch: "TERMINAL"; status: EvidenceStatus }
  | { branch: "NETWORK_ERROR"; cause: unknown };
