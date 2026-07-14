/**
 * captureEvidence — client-side upload orchestrator (Tasks 10.3–10.6).
 *
 * Orchestrates the full Upload_Flow:
 *   validateFile → computeSHA256 → checkIdempotency → branch dispatch
 *   → createEvidenceDocument → storageTransfer / resumeUpload
 *
 * All timestamps use new Date(). Firestore Timestamp is never imported here.
 * The client NEVER writes to the evidence document after initial creation —
 * all post-creation writes go through Cloud Functions (reportUploadFailure,
 * retriggerProcessing).
 *
 * Requirements: 1.1–1.8, 2.1–2.7, 10.5
 * Design: §Upload Flow — Client-Side Steps
 */
import { validateFile, type EvidenceFileType } from "./validateFile.js";
import { checkIdempotency } from "./checkIdempotency.js";
import type { UploadResult, EvidenceDocument } from "../types/evidence.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvidenceMetadataInput {
  incidentId: string;
  capturedAt: Date;
  deviceInfo: string;
  locationHash: string | null;
  incidentContext: string | null;
}

/** Minimal Firestore-like interface so the client module stays testable without the SDK. */
export interface FirestoreAdapter {
  createDocument(evidenceId: string, doc: Partial<EvidenceDocument>): Promise<void>;
  getDocument(evidenceId: string): Promise<Partial<EvidenceDocument> | null>;
  getDocumentWithRetry(evidenceId: string, retries: number): Promise<Partial<EvidenceDocument> | null>;
}

/** Minimal Storage-like interface */
export interface StorageAdapter {
  upload(storageRef: string, data: ArrayBuffer, mimeType: string): Promise<void>;
}

/** Callable-function adapter (wraps Firebase Functions or any HTTPS caller) */
export interface FunctionsAdapter {
  call(name: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function captureEvidence(
  evidenceId: string,
  file: { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
  userId: string,
  metadata: EvidenceMetadataInput,
  firestore: FirestoreAdapter,
  storage: StorageAdapter,
  functions: FunctionsAdapter,
  computeHash: (data: ArrayBuffer) => Promise<string>
): Promise<UploadResult> {
  // Step 1: Pre-upload validation
  const validation = validateFile(file.type, file.size);
  if (!validation.valid) {
    return { success: false, error: "VALIDATION_ERROR", message: validation.reason };
  }
  const fileType = validation.type;

  // Step 2: On-device SHA-256 (before any data leaves the device)
  let sha256Hash: string;
  const rawBuffer = await file.arrayBuffer();
  sha256Hash = await computeHash(rawBuffer);

  // Step 3: Three-branch idempotency check (with 1 retry on network error)
  let existing: Partial<EvidenceDocument> | null;
  try {
    existing = await firestore.getDocumentWithRetry(evidenceId, 1);
  } catch (e) {
    return { success: false, error: "NETWORK_ERROR", message: "Could not determine current document status." };
  }

  const idempotencyResult = checkIdempotency(
    existing
      ? { status: existing.status!, updatedAt: existing.updatedAt! }
      : null
  );

  switch (idempotencyResult.branch) {
    case "COMPLETE_DUPLICATE":
      return { success: true, evidenceId, idempotent: true };

    case "CONCURRENT":
      return { success: false, error: "CONCURRENT_UPLOAD", message: "Upload in progress — please wait." };

    case "TERMINAL":
      return {
        success: false,
        error: "TERMINAL_FAILURE",
        message: `Evidence item is in terminal state: ${idempotencyResult.status}`,
      };

    case "STALLED":
      return await performResume(evidenceId, firestore, functions);

    case "FRESH":
      return await performFreshUpload(
        evidenceId, file, userId, fileType, sha256Hash, rawBuffer, metadata,
        firestore, storage, functions
      );

    default:
      return { success: false, error: "NETWORK_ERROR", message: "Unexpected idempotency branch." };
  }
}

// ---------------------------------------------------------------------------
// Fresh upload path (Steps 3–5)
// ---------------------------------------------------------------------------

async function performFreshUpload(
  evidenceId: string,
  file: { name: string; type: string; size: number },
  userId: string,
  fileType: EvidenceFileType,
  sha256Hash: string,
  rawBuffer: ArrayBuffer,
  metadata: EvidenceMetadataInput,
  firestore: FirestoreAdapter,
  storage: StorageAdapter,
  functions: FunctionsAdapter
): Promise<UploadResult> {
  const now = new Date();
  const storageRef = `evidence/${evidenceId}/${file.name}`;

  // Step 4: Create Firestore document (status: uploading) BEFORE transferring file
  const doc: Partial<EvidenceDocument> = {
    evidenceId,
    incidentId: metadata.incidentId,
    userId,
    type: fileType,
    storageRef,
    originalFilename: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    sha256Hash,
    encryptionKeyRef: "",
    encryptionIV: "",
    status: "uploading",
    retentionExpiresAt: null,
    legalHoldReason: null,
    chainOfCustody: [],
    createdAt: now,
    updatedAt: now,
    metadata: {
      capturedAt: metadata.capturedAt,
      deviceInfo: metadata.deviceInfo,
      locationHash: metadata.locationHash,
      incidentContext: metadata.incidentContext,
    },
  };

  try {
    await firestore.createDocument(evidenceId, doc);
  } catch (e) {
    // Req 1.7: no Storage upload if Firestore creation fails
    return {
      success: false,
      error: "FIRESTORE_CREATE_FAILED",
      message: "Upload could not be started — please try again.",
    };
  }

  // Step 5: Transfer file to Storage
  try {
    await storage.upload(storageRef, rawBuffer, file.type);
  } catch (e) {
    // Req 1.8: signal failure via Cloud Function, never write Firestore directly
    const result = await functions.call("reportUploadFailure", { evidenceId });
    if (result["outcome"] === "ALREADY_PROCESSING") {
      return { success: false, error: "UPLOAD_IN_PROGRESS", message: "Upload is being processed server-side." };
    }
    return { success: false, error: "STORAGE_TRANSFER_FAILED", message: "Storage transfer failed." };
  }

  return { success: true, evidenceId };
}

// ---------------------------------------------------------------------------
// Resume path (Req 2.3, dual-condition transaction)
// ---------------------------------------------------------------------------

async function performResume(
  evidenceId: string,
  firestore: FirestoreAdapter,
  functions: FunctionsAdapter
): Promise<UploadResult> {
  // The client calls retriggerProcessing — it performs the dual-condition
  // transaction server-side (status + updatedAt staleness check at commit time).
  try {
    const result = await functions.call("retriggerProcessing", { evidenceId });
    if (result["outcome"] === "FILE_NOT_FOUND") {
      return {
        success: false,
        error: "STORAGE_TRANSFER_FAILED",
        message: "Storage file missing — please re-upload the file.",
      };
    }
    if (result["outcome"] === "RETRIGGERED") {
      // Pipeline restarted — success from the client's perspective
      return { success: true, evidenceId };
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "PRECONDITION_FAILED") {
      // Cloud Function rejected the resume (status/updatedAt check failed)
      // — the document may have been concurrently claimed or failed
      return { success: false, error: "CONCURRENT_UPLOAD", message: "Upload is being processed server-side." };
    }
  }
  return { success: false, error: "TERMINAL_FAILURE", message: "Resume failed — evidence item may have reached a terminal state." };
}
