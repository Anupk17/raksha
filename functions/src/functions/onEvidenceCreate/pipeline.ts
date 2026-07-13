/**
 * onEvidenceCreate — Core pipeline logic (Steps 1–12).
 *
 * This module is intentionally separated from the Cloud Function trigger
 * registration so the pipeline can be unit-tested without the
 * firebase-functions SDK, and re-used by retriggerProcessing (which runs
 * the same pipeline on a document that was never fully processed).
 *
 * Pipeline steps (from design.md §onEvidenceCreate Cloud Function Pipeline):
 *   1.  Conditional transition uploading → processing
 *   2.  Download raw bytes from Storage (3 retries on transient errors)
 *   3.  Compute server-side SHA-256
 *   4.  Compare to doc.sha256Hash — mismatch → integrity_failed + stop
 *   5.  Generate DEK + IV via KMSClient (3 retries on transient errors)
 *   6.  Encrypt raw bytes with AES-256-GCM
 *   7.  Overwrite Storage object with encrypted bytes
 *   8.  Encode encryptionKeyRef (encryptedDEK) and encryptionIV (base64 IV)
 *   9.  Compute retentionExpiresAt
 *   10. Compute integritySnapshot for the 'uploaded' custody entry
 *   11. Single atomic transaction: append 'uploaded' entry + status → available
 *   12. Unrecoverable error path: conditional status → failed/encryption_failed
 *
 * Race condition (Req 2 vs Req 11 — design.md §Race Condition Resolution):
 *   Both Step 1 and Step 12 use conditional Firestore transactions. If the
 *   client's retriggerProcessing or resume path commits a status change before
 *   Step 12's transaction, Step 12 aborts and logs
 *   "[onEvidenceCreate] failed-transition aborted for {id} — resume path took precedence"
 *   and stops. First committer wins; no elevated authority on either side.
 *
 * Requirements: 3, 4, 5, 8, 10, 11
 */
import crypto from "crypto";
import type { Firestore, DocumentReference } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import type { KMSClient } from "../../kms/kms.interface.js";
import { aesGcmEncrypt } from "../../utils/aesGcm.js";
import { appendCustodyEntry } from "../../utils/appendCustodyEntry.js";
import { assertDate, assertDateOrNull } from "../../utils/assertDate.js";
import { computeIntegritySnapshot } from "../../utils/integritySnapshot.js";
import {
  getRetentionPeriodDays,
  computeRetentionExpiresAt,
} from "../../utils/retentionConfig.js";
import type {
  EvidenceDocument,
  ChainOfCustodyEntry,
} from "../../types/evidence.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * KMS key ring resource name.
 * In production this is read from EVIDENCE_KMS_KEY_RING_REF env var.
 * Must be set before deployment; defaults to a sentinel that fails loudly
 * if not configured.
 */
export const KEY_RING_REF =
  process.env["EVIDENCE_KMS_KEY_RING_REF"] ??
  "projects/UNSET/locations/global/keyRings/UNSET/cryptoKeys/UNSET";

/** Maximum transient-error retries for Storage download and KMS calls. */
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Runs the full onEvidenceCreate pipeline (Steps 1–12) for a given evidenceId.
 *
 * Called from:
 *   - The Firestore onCreate trigger (index.ts)
 *   - retriggerProcessing (for stalled uploads — re-uses the same pipeline)
 *
 * @param evidenceId  - Firestore document ID
 * @param db          - Firestore Admin SDK instance
 * @param bucket      - Firebase Storage bucket (Admin SDK)
 * @param kms         - Injectable KMSClient (KMSMock in test/emulator)
 * @param logger      - Structured logger (console in tests, functions.logger in prod)
 */
export async function runEvidenceCreatePipeline(
  evidenceId: string,
  db: Firestore,
  bucket: ReturnType<Storage["bucket"]>,
  kms: KMSClient,
  logger: PipelineLogger
): Promise<void> {
  const ref = db.collection("evidence").doc(evidenceId);

  // -------------------------------------------------------------------------
  // Step 1 — Transition uploading → processing (conditional)
  // -------------------------------------------------------------------------
  const step1Result = await step1_transitionToProcessing(ref, db, evidenceId, logger);
  if (step1Result === "ABORTED") {
    // Status was not 'uploading' at commit time — another actor already moved it.
    // Log and stop; the winning actor is responsible for forward progress.
    logger.warn(
      `[onEvidenceCreate] Step 1 aborted for ${evidenceId} — ` +
        `status was not 'uploading' at commit time`
    );
    return;
  }

  // Snapshot of document data after Step 1 (used throughout the pipeline)
  const docSnap = await ref.get();
  if (!docSnap.exists) {
    logger.error(`[onEvidenceCreate] Document ${evidenceId} vanished after Step 1`);
    return;
  }
  const docData = docSnap.data() as Record<string, unknown>;

  // Deserialize all timestamp fields — assertDate throws on Firestore Timestamp
  const createdAt = assertDate(docData["createdAt"], "createdAt");
  assertDateOrNull(docData["retentionExpiresAt"], "retentionExpiresAt"); // nullable, just validate
  const clientHash = docData["sha256Hash"] as string;
  const storageRef = docData["storageRef"] as string;

  // -------------------------------------------------------------------------
  // Steps 2–11 (wrapped in error handler for Step 12)
  // -------------------------------------------------------------------------
  let isEncryptionError = false;
  let storageFile: ReturnType<typeof bucket.file> | null = null;

  try {
    storageFile = bucket.file(storageRef);

    // -----------------------------------------------------------------------
    // Step 2 — Download raw bytes (3 retries on transient errors, Req 3.5)
    // -----------------------------------------------------------------------
    const rawBytes = await withRetry(
      () => downloadFile(storageFile!),
      MAX_RETRIES,
      (err, attempt) =>
        logger.warn(
          `[onEvidenceCreate] Step 2 download attempt ${attempt} failed for ${evidenceId}: ${err.message}`
        )
    );

    // -----------------------------------------------------------------------
    // Step 3 — Server-side SHA-256
    // -----------------------------------------------------------------------
    const serverHash = crypto
      .createHash("sha256")
      .update(rawBytes)
      .digest("hex");

    // -----------------------------------------------------------------------
    // Step 4 — Hash verification (Req 3.1, 3.2)
    // -----------------------------------------------------------------------
    if (serverHash !== clientHash) {
      await step4_integrityFailed(
        ref,
        db,
        evidenceId,
        clientHash,
        serverHash,
        docData,
        logger
      );
      return; // pipeline stops here
    }

    // -----------------------------------------------------------------------
    // Step 5 — Generate DEK + IV via KMS (3 retries, Req 4.1)
    // -----------------------------------------------------------------------
    isEncryptionError = true; // from here, errors are encryption errors
    const { encryptedDEK, plaintextDEK, iv } = await withRetry(
      () => kms.generateDataEncryptionKey(KEY_RING_REF),
      MAX_RETRIES,
      (err, attempt) =>
        logger.warn(
          `[onEvidenceCreate] Step 5 KMS attempt ${attempt} failed for ${evidenceId}: ${err.message}`
        )
    );

    // -----------------------------------------------------------------------
    // Step 6 — AES-256-GCM encryption (Req 4.1)
    // -----------------------------------------------------------------------
    const encryptedBytes = aesGcmEncrypt(rawBytes, plaintextDEK, iv);

    // -----------------------------------------------------------------------
    // Step 7 — Overwrite Storage object with encrypted bytes (Req 4.1)
    // -----------------------------------------------------------------------
    await storageFile.save(encryptedBytes, {
      contentType: "application/octet-stream",
      metadata: { contentEncoding: "aes-256-gcm" },
    });

    // -----------------------------------------------------------------------
    // Step 8 — Encode key references
    // iv is 12 bytes; base64 of 12 bytes = 16 chars (with padding)
    // -----------------------------------------------------------------------
    const encryptionIV = iv.toString("base64"); // 12 bytes → 16-char base64
    const encryptionKeyRef = encryptedDEK;
    isEncryptionError = false; // encryption succeeded

    // -----------------------------------------------------------------------
    // Step 9 — Compute retentionExpiresAt (Req 8.1)
    // -----------------------------------------------------------------------
    const retentionDays = getRetentionPeriodDays();
    const retentionExpiresAt = computeRetentionExpiresAt(createdAt, retentionDays);

    // -----------------------------------------------------------------------
    // Steps 10 + 11 — integritySnapshot + atomic available transition (Req 5.3, 5.5)
    // -----------------------------------------------------------------------
    await step11_finalTransaction(
      ref,
      db,
      evidenceId,
      encryptionKeyRef,
      encryptionIV,
      retentionExpiresAt,
      clientHash,
      docData,
      logger
    );
  } catch (err: unknown) {
    // -----------------------------------------------------------------------
    // Step 12 — Unrecoverable error path (Req 11.5, design §Step 12)
    // -----------------------------------------------------------------------
    await step12_unrecoverableError(
      ref,
      db,
      evidenceId,
      storageFile,
      isEncryptionError,
      err,
      logger
    );
  }
}

// ---------------------------------------------------------------------------
// Step implementations (package-private — exported only for testing)
// ---------------------------------------------------------------------------

/** Step 1: conditional uploading → processing transition. */
export async function step1_transitionToProcessing(
  ref: DocumentReference,
  db: Firestore,
  evidenceId: string,
  logger: PipelineLogger
): Promise<"OK" | "ABORTED"> {
  let aborted = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      logger.warn(`[onEvidenceCreate] Step 1: document ${evidenceId} not found`);
      aborted = true;
      return;
    }
    const status = snap.data()?.["status"];
    if (status !== "uploading") {
      // Another actor (reportUploadFailure, retriggerProcessing) already moved status.
      aborted = true;
      return;
    }
    tx.update(ref, { status: "processing", updatedAt: new Date() });
  });
  return aborted ? "ABORTED" : "OK";
}

/** Step 4: write integrity_failed status + custody entry. */
export async function step4_integrityFailed(
  ref: DocumentReference,
  db: Firestore,
  evidenceId: string,
  expectedHash: string,
  computedHash: string,
  docData: Record<string, unknown>,
  logger: PipelineLogger
): Promise<void> {
  logger.warn(
    `[onEvidenceCreate] Step 4 hash mismatch for ${evidenceId}: ` +
      `expected=${expectedHash} computed=${computedHash}`
  );
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const entry: ChainOfCustodyEntry = {
      action: "status_changed",
      performedBy: "cloud_function",
      timestamp: new Date(),
      evidenceId,
      metadata: {
        reason: "hash_mismatch",
        expectedHash,
        computedHash,
      },
      integritySnapshot: safeIntegritySnapshot(docData, evidenceId, logger),
    };
    // Use read-spread-write pattern — appendCustodyEntry is the only permitted
    // path but here we need to simultaneously write status, so we inline the
    // pattern and call tx.update once (matching design §Step 4).
    const current = (snap.data()?.["chainOfCustody"] ?? []) as ChainOfCustodyEntry[];
    tx.update(ref, {
      status: "integrity_failed",
      chainOfCustody: [...current, entry],
      updatedAt: new Date(),
    });
  });
}

/** Steps 10 + 11: atomic custody append + available transition. */
export async function step11_finalTransaction(
  ref: DocumentReference,
  db: Firestore,
  evidenceId: string,
  encryptionKeyRef: string,
  encryptionIV: string,
  retentionExpiresAt: Date,
  clientHash: string,
  docData: Record<string, unknown>,
  logger: PipelineLogger
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new Error(`[onEvidenceCreate] Step 11: document ${evidenceId} not found`);
    }
    const current = snap.data()!;
    if (current["status"] !== "processing") {
      // Concurrent actor moved status — log and abort cleanly.
      logger.warn(
        `[onEvidenceCreate] Step 11 aborted for ${evidenceId} — ` +
          `status was '${current["status"]}', expected 'processing'`
      );
      throw new Error("ABORT_UNEXPECTED_STATUS");
    }
    const custody = (current["chainOfCustody"] ?? []) as ChainOfCustodyEntry[];
    const uploadedEntry: ChainOfCustodyEntry = {
      action: "uploaded",
      performedBy: "cloud_function",
      timestamp: new Date(),
      evidenceId,
      metadata: { sha256Hash: clientHash },
      integritySnapshot: safeIntegritySnapshot(docData, evidenceId, logger),
    };
    tx.update(ref, {
      status: "available",
      encryptionKeyRef,
      encryptionIV,
      retentionExpiresAt,
      chainOfCustody: [...custody, uploadedEntry],
      updatedAt: new Date(),
    });
  });
}

/** Step 12: unrecoverable error — conditional failed/encryption_failed transition. */
export async function step12_unrecoverableError(
  ref: DocumentReference,
  db: Firestore,
  evidenceId: string,
  storageFile: ReturnType<ReturnType<Storage["bucket"]>["file"]> | null,
  isEncryptionError: boolean,
  err: unknown,
  logger: PipelineLogger
): Promise<void> {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const errorCode =
    (err as Record<string, unknown>)?.["code"]?.toString() ?? "UNKNOWN";

  // For ABORT_UNEXPECTED_STATUS in Step 11, the resume path already committed.
  if (errorMessage === "ABORT_UNEXPECTED_STATUS") {
    logger.warn(
      `[onEvidenceCreate] Step 11 transaction aborted for ${evidenceId} — ` +
        `resume path took precedence`
    );
    return;
  }

  logger.error(
    `[onEvidenceCreate] Unrecoverable error for ${evidenceId}: ${errorMessage}`
  );

  // For encryption_failed: attempt to delete the unencrypted Storage object
  // before committing the terminal status (Req 4.6, design §Step 12).
  if (isEncryptionError && storageFile !== null) {
    let deleted = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await storageFile.delete({ ignoreNotFound: true });
        deleted = true;
        break;
      } catch (delErr) {
        logger.warn(
          `[onEvidenceCreate] Storage deletion attempt ${attempt} failed for ` +
            `${evidenceId}: ${delErr instanceof Error ? delErr.message : String(delErr)}`
        );
      }
    }
    if (!deleted) {
      logger.error(
        `[onEvidenceCreate] CRITICAL: Could not delete unencrypted Storage object ` +
          `for ${evidenceId} after ${MAX_RETRIES} attempts. Manual remediation required.`
      );
    }
  }

  // Conditional transaction: write terminal status only if still uploading/processing.
  const targetStatus = isEncryptionError ? "encryption_failed" : "failed";
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const status = snap.data()?.["status"];
      if (status !== "uploading" && status !== "processing") {
        // Resume path already committed — abort and yield.
        logger.warn(
          `[onEvidenceCreate] failed-transition aborted for ${evidenceId} — ` +
            `resume path took precedence`
        );
        throw new Error("ABORT_YIELD");
      }
      const custody = (snap.data()?.["chainOfCustody"] ?? []) as ChainOfCustodyEntry[];
      const errorEntry: ChainOfCustodyEntry = {
        action: "status_changed",
        performedBy: "cloud_function",
        timestamp: new Date(),
        evidenceId,
        metadata: {
          reason: "unrecoverable_error",
          errorCode,
          errorMessage: errorMessage.slice(0, 512), // cap length for Firestore field
        },
        integritySnapshot: null, // doc state is unreliable at this point
      };
      tx.update(ref, {
        status: targetStatus,
        chainOfCustody: [...custody, errorEntry],
        updatedAt: new Date(),
      });
    });
  } catch (txErr) {
    if (
      txErr instanceof Error &&
      txErr.message === "ABORT_YIELD"
    ) {
      // Logged above — no further action.
      return;
    }
    // Re-throw anything else so the Cloud Function runtime can retry.
    throw txErr;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Downloads all bytes of a Storage file as a single Buffer. */
async function downloadFile(
  file: ReturnType<ReturnType<Storage["bucket"]>["file"]>
): Promise<Buffer> {
  const [contents] = await file.download();
  return contents;
}

/**
 * Retries an async operation up to maxAttempts times on any thrown error.
 * Does NOT retry on success.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  onRetry?: (err: Error, attempt: number) => void
): Promise<T> {
  let lastErr: Error = new Error("withRetry: no attempts made");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (onRetry) onRetry(lastErr, attempt);
      if (attempt === maxAttempts) break;
      // Brief backoff: 200ms × attempt (200, 400, 600ms)
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw lastErr;
}

/**
 * Safely computes an integrity snapshot, returning null on failure rather
 * than crashing the pipeline. Used in error paths where the document state
 * may already be partially corrupted.
 */
function safeIntegritySnapshot(
  docData: Record<string, unknown>,
  evidenceId: string,
  logger: PipelineLogger
): string | null {
  try {
    // computeIntegritySnapshot needs a typed EvidenceDocument subset.
    // Cast from raw Firestore data — fields must exist or it will throw.
    return computeIntegritySnapshot(docData as unknown as EvidenceDocument);
  } catch (err) {
    logger.warn(
      `[onEvidenceCreate] Could not compute integritySnapshot for ${evidenceId}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Logger interface (allows injecting a test double)
// ---------------------------------------------------------------------------

export interface PipelineLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
