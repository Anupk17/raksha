/**
 * retriggerProcessing — HTTPS callable Cloud Function.
 *
 * Re-runs the onEvidenceCreate pipeline (steps 2–11) on an existing evidence
 * document that stalled in 'uploading' status after a previous Upload_Flow
 * was interrupted.
 *
 * Why this exists (design.md §Race Condition Resolution — The Resume Mechanism):
 *   The client's resume path cannot re-create the Firestore document — that
 *   would fire a new onCreate trigger for a document that already has a
 *   chain-of-custody log, lose the createdAt timestamp, and create a gap in
 *   the audit trail. Instead, the client calls this function, which re-runs
 *   the pipeline on the existing document using Admin SDK.
 *
 * Preconditions enforced before running the pipeline:
 *   1. Caller is authenticated (401 otherwise).
 *   2. Document exists (404 otherwise).
 *   3. Caller is the document owner (403 otherwise).
 *   4. Status is 'uploading' AND updatedAt was refreshed within the last 30s
 *      (i.e., the resume transaction just claimed it) — prevents double-triggering.
 *   5. The Storage file at storageRef exists — if not, returns FILE_NOT_FOUND
 *      and the client must re-upload before calling again.
 *
 * Requirements: 2.3, 2.7, 11.5
 * Design: §Race Condition Resolution — retriggerProcessing Function Design
 */
import type { Firestore } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import type { KMSClient } from "../kms/kms.interface.js";
import { runEvidenceCreatePipeline, type PipelineLogger } from "./onEvidenceCreate/pipeline.js";
import { assertDate } from "../utils/assertDate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetriggerOutcome = "RETRIGGERED" | "FILE_NOT_FOUND";

export interface RetriggerProcessingRequest {
  evidenceId: string;
}

export interface RetriggerProcessingResult {
  outcome: RetriggerOutcome;
}

// ---------------------------------------------------------------------------
// Core logic (exported for testing)
// ---------------------------------------------------------------------------

/** How recently updatedAt must have been set for us to accept the claim (ms). */
const CLAIM_WINDOW_MS = 30_000; // 30 seconds

/**
 * Runs the retriggerProcessing logic.
 *
 * @param evidenceId  - ID of the evidence document to reprocess.
 * @param callerUid   - Firebase Auth UID of the requesting user.
 * @param db          - Firestore Admin SDK instance.
 * @param bucket      - Firebase Storage bucket (Admin SDK).
 * @param kms         - Injectable KMSClient.
 * @param logger      - Structured logger.
 * @returns { outcome } — 'RETRIGGERED' if pipeline was started, 'FILE_NOT_FOUND'
 *                        if the Storage file is missing (client must re-upload first).
 * @throws Error(code=UNAUTHENTICATED)   if callerUid is falsy.
 * @throws Error(code=NOT_FOUND)         if document does not exist.
 * @throws Error(code=PERMISSION_DENIED) if caller is not the owner.
 * @throws Error(code=PRECONDITION_FAILED) if document is not in a retriggerable state.
 */
export async function runRetriggerProcessing(
  evidenceId: string,
  callerUid: string,
  db: Firestore,
  bucket: ReturnType<Storage["bucket"]>,
  kms: KMSClient,
  logger: PipelineLogger
): Promise<RetriggerProcessingResult> {
  // Step 1 — Auth check
  if (!callerUid) {
    const err = new Error("retriggerProcessing: caller is not authenticated");
    (err as NodeJS.ErrnoException).code = "UNAUTHENTICATED";
    throw err;
  }

  // Step 2 — Fetch document
  const ref = db.collection("evidence").doc(evidenceId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error(`retriggerProcessing: evidence document '${evidenceId}' not found`);
    (err as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw err;
  }

  const data = snap.data() as Record<string, unknown>;

  // Step 3 — Ownership check
  if (data["userId"] !== callerUid) {
    const err = new Error(
      `retriggerProcessing: caller '${callerUid}' is not the owner of '${evidenceId}'`
    );
    (err as NodeJS.ErrnoException).code = "PERMISSION_DENIED";
    throw err;
  }

  // Step 4 — Precondition: status must be 'uploading' and the resume
  // transaction must have just claimed the document (updatedAt within 30s).
  const status = data["status"] as string;
  if (status !== "uploading") {
    const err = new Error(
      `retriggerProcessing: document '${evidenceId}' has status '${status}', ` +
        `expected 'uploading'. The resume transaction must claim the document first.`
    );
    (err as NodeJS.ErrnoException).code = "PRECONDITION_FAILED";
    throw err;
  }

  // Deserialize updatedAt — may come back as Firestore Timestamp in some configs.
  const rawUpdatedAt = data["updatedAt"];
  let updatedAt: Date;
  try {
    if (rawUpdatedAt && typeof (rawUpdatedAt as { toDate?: unknown }).toDate === "function") {
      updatedAt = (rawUpdatedAt as { toDate: () => Date }).toDate();
    } else {
      updatedAt = assertDate(rawUpdatedAt, "updatedAt");
    }
  } catch {
    const err = new Error(
      `retriggerProcessing: could not deserialize updatedAt for '${evidenceId}'`
    );
    (err as NodeJS.ErrnoException).code = "PRECONDITION_FAILED";
    throw err;
  }

  const staleness = Date.now() - updatedAt.getTime();
  if (staleness > CLAIM_WINDOW_MS) {
    const err = new Error(
      `retriggerProcessing: document '${evidenceId}' updatedAt is ${Math.round(staleness / 1000)}s ago, ` +
        `exceeds the ${CLAIM_WINDOW_MS / 1000}s claim window. ` +
        `The resume transaction must set updatedAt immediately before calling this function.`
    );
    (err as NodeJS.ErrnoException).code = "PRECONDITION_FAILED";
    throw err;
  }

  // Step 5 — File existence check
  const storageRef = data["storageRef"] as string;
  const file = bucket.file(storageRef);
  const [exists] = await file.exists();
  if (!exists) {
    logger.warn(
      `[retriggerProcessing] Storage file missing for ${evidenceId} at ${storageRef}. ` +
        `Client must re-upload before retriggering.`
    );
    return { outcome: "FILE_NOT_FOUND" };
  }

  // Step 6 — Run pipeline steps 2–11 on the existing document.
  // runEvidenceCreatePipeline handles the uploading→processing Step 1 conditional
  // write internally (same as the onCreate trigger).
  logger.info(`[retriggerProcessing] Starting pipeline for stalled document ${evidenceId}`);
  await runEvidenceCreatePipeline(evidenceId, db, bucket, kms, logger);

  return { outcome: "RETRIGGERED" };
}

// ---------------------------------------------------------------------------
// Firebase Functions registration
// ---------------------------------------------------------------------------

export function createRetriggerProcessingHandler(
  db: Firestore,
  bucket: ReturnType<Storage["bucket"]>,
  kms: KMSClient,
  logger: PipelineLogger
) {
  return async (
    data: RetriggerProcessingRequest,
    context: { auth?: { uid: string } }
  ): Promise<RetriggerProcessingResult> => {
    const callerUid = context.auth?.uid ?? "";
    return runRetriggerProcessing(data.evidenceId, callerUid, db, bucket, kms, logger);
  };
}
