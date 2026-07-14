/**
 * reportUploadFailure — HTTPS callable Cloud Function.
 *
 * Signals a client-side Storage transfer failure without the client ever
 * writing to Firestore directly. Replaces the old (removed) security-rule
 * carve-out that allowed clients to set status:'failed' directly.
 *
 * Why this exists (design.md §Client Write Carve-Out: Security Analysis):
 *   A direct client write to status:'failed' created a race window between
 *   document creation and onEvidenceCreate Step 1 committing. A compromised
 *   client could abort the pipeline, leaving an unencrypted blob in Storage
 *   with no custody entry. This function performs the same conditional write
 *   server-side, ensuring the audit trail is always server-recorded.
 *
 * Behaviour:
 *   - Verifies Firebase Auth and ownership.
 *   - Runs a conditional Firestore transaction:
 *       if status === 'uploading' → sets 'failed' + appends status_changed entry
 *       if status !== 'uploading' → the pipeline is already in-flight; returns
 *                                   ALREADY_PROCESSING so the client knows not
 *                                   to show the user a hard error.
 *   - Returns { outcome: 'FAILED' | 'ALREADY_PROCESSING' }.
 *
 * Requirements: 1.8, 5.1, 5.4, 6.2
 * Design: §reportUploadFailure Function Design
 */
import type { Firestore } from "firebase-admin/firestore";
import type { EvidenceDocument, ChainOfCustodyEntry } from "../types/evidence.js";
import { computeIntegritySnapshot } from "../utils/integritySnapshot.js";
import { deserializeFirestoreDate } from "../utils/assertDate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportUploadFailureRequest {
  evidenceId: string;
}

export type ReportUploadFailureOutcome = "FAILED" | "ALREADY_PROCESSING";

export interface ReportUploadFailureResult {
  outcome: ReportUploadFailureOutcome;
}

// ---------------------------------------------------------------------------
// Core logic (exported for testing and reuse by retriggerProcessing)
// ---------------------------------------------------------------------------

/**
 * Runs the reportUploadFailure logic against the given Firestore instance.
 * Separated from the firebase-functions registration so it can be unit-tested
 * without the SDK.
 *
 * @param evidenceId  - ID of the evidence document to mark as failed.
 * @param callerUid   - Firebase Auth UID of the requesting user.
 * @param db          - Firestore Admin SDK instance.
 * @returns { outcome } — 'FAILED' if we committed, 'ALREADY_PROCESSING' if
 *                        the pipeline was already in-flight past 'uploading'.
 * @throws Error with code 'NOT_FOUND'   if document does not exist.
 * @throws Error with code 'PERMISSION_DENIED' if caller is not the owner.
 * @throws Error with code 'UNAUTHENTICATED' if callerUid is falsy.
 */
export async function runReportUploadFailure(
  evidenceId: string,
  callerUid: string,
  db: Firestore
): Promise<ReportUploadFailureResult> {
  // Step 1 — Auth check
  if (!callerUid) {
    const err = new Error("reportUploadFailure: caller is not authenticated");
    (err as NodeJS.ErrnoException).code = "UNAUTHENTICATED";
    throw err;
  }

  // Step 2 — Fetch document
  const ref = db.collection("evidence").doc(evidenceId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error(
      `reportUploadFailure: evidence document '${evidenceId}' not found`
    );
    (err as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw err;
  }

  const data = snap.data() as Record<string, unknown>;

  // Step 3 — Ownership check
  if (data["userId"] !== callerUid) {
    const err = new Error(
      `reportUploadFailure: caller '${callerUid}' is not the owner of '${evidenceId}'`
    );
    (err as NodeJS.ErrnoException).code = "PERMISSION_DENIED";
    throw err;
  }

  // Step 4 — Conditional transaction
  let outcome: ReportUploadFailureOutcome = "ALREADY_PROCESSING";

  await db.runTransaction(async (tx) => {
    const txSnap = await tx.get(ref);
    if (!txSnap.exists) {
      // Raced with a delete (shouldn't happen — documents are never deleted
      // by the client — but guard defensively).
      return;
    }
    const txData = txSnap.data() as Record<string, unknown>;
    const status = txData["status"] as string;

    if (status !== "uploading") {
      // Pipeline already claimed the document (processing, available, failed,
      // etc.) — do nothing. The client should treat this as success or wait.
      outcome = "ALREADY_PROCESSING";
      return;
    }

    // Document is still in 'uploading' — we win the race; mark it failed.
    const custody = (txData["chainOfCustody"] ?? []) as ChainOfCustodyEntry[];

    // Safe snapshot: createdAt must exist on a freshly created document.
    // Use safeIntegritySnapshot pattern — if the doc is malformed, null is
    // acceptable here since this is the failure path.
    let integritySnapshot: string | null = null;
    try {
      // Deserialize createdAt so computeIntegritySnapshot can call toISOString()
      const raw = txData["createdAt"];
      txData["createdAt"] = deserializeFirestoreDate(raw, "createdAt");
      integritySnapshot = computeIntegritySnapshot(
        txData as unknown as EvidenceDocument
      );
    } catch {
      // Non-fatal — snapshot will be null
    }

    const entry: ChainOfCustodyEntry = {
      action: "status_changed",
      performedBy: "cloud_function",
      timestamp: new Date(),
      evidenceId,
      metadata: {
        reason: "client_storage_failure",
        priorStatus: "uploading",
        newStatus: "failed",
      },
      integritySnapshot,
    };

    tx.update(ref, {
      status: "failed",
      chainOfCustody: [...custody, entry],
      updatedAt: new Date(),
    });

    outcome = "FAILED";
  });

  return { outcome };
}

// ---------------------------------------------------------------------------
// Firebase Functions registration (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Registers the reportUploadFailure HTTPS callable function.
 * Call this from src/index.ts.
 */
export function createReportUploadFailureHandler(db: Firestore) {
  return async (
    data: ReportUploadFailureRequest,
    context: { auth?: { uid: string } }
  ): Promise<ReportUploadFailureResult> => {
    const callerUid = context.auth?.uid ?? "";
    return runReportUploadFailure(data.evidenceId, callerUid, db);
  };
}
