/**
 * processEvidenceExpiry — Cloud Scheduler-triggered function.
 *
 * Transitions eligible evidence documents from their current status to
 * 'expired' when retentionExpiresAt has passed and the document is not
 * under legal_hold.
 *
 * Steps (design.md §processEvidenceExpiry Function Design):
 *   1. Validate retention config — abort entire run if invalid.
 *   2. Query eligible documents.
 *   3. For each document, run a conditional transaction:
 *        - Re-check eligibility at commit time (guards concurrent setLegalHold).
 *        - Append status_changed custody entry + set status:'expired'.
 *   4. Continue-on-failure: log individual document errors, never abort the run.
 *
 * Requirements: 8.2, 8.3, 8.4, 8.7
 */
import type { Firestore } from "firebase-admin/firestore";
import { getRetentionPeriodDays } from "../utils/retentionConfig.js";
import { computeIntegritySnapshot } from "../utils/integritySnapshot.js";
import { deserializeFirestoreDate } from "../utils/assertDate.js";
import type { ChainOfCustodyEntry, EvidenceDocument } from "../types/evidence.js";
import type { PipelineLogger } from "./onEvidenceCreate/pipeline.js";

const INELIGIBLE_STATUSES = [
  "legal_hold", "expired", "failed", "integrity_failed", "encryption_failed",
] as const;

export interface ExpiryRunResult {
  processed: number;
  succeeded: number;
  failed: number;
}

export async function runProcessEvidenceExpiry(
  db: Firestore,
  logger: PipelineLogger
): Promise<ExpiryRunResult> {
  // Step 1 — Validate config (abort entire run on bad config)
  let retentionDays: number;
  try {
    retentionDays = getRetentionPeriodDays();
  } catch (e) {
    logger.error(
      `[processEvidenceExpiry] CRITICAL: invalid retention config — aborting run. ${(e as Error).message}`
    );
    throw e;
  }

  logger.info(`[processEvidenceExpiry] Starting expiry run (retentionDays=${retentionDays})`);

  // Step 2 — Query eligible documents
  const now = new Date();
  const snapshot = await db
    .collection("evidence")
    .where("retentionExpiresAt", "<", now)
    .where("status", "not-in", Array.from(INELIGIBLE_STATUSES))
    .get();

  const result: ExpiryRunResult = { processed: snapshot.size, succeeded: 0, failed: 0 };

  // Step 3 — Process each document individually (continue-on-failure)
  for (const docSnap of snapshot.docs) {
    const evidenceId = docSnap.id;
    try {
      await db.runTransaction(async (tx) => {
        const current = await tx.get(docSnap.ref);
        if (!current.exists) return;

        const currentStatus = current.data()!["status"] as string;
        if ((INELIGIBLE_STATUSES as readonly string[]).includes(currentStatus)) {
          // Concurrently transitioned (e.g., setLegalHold ran between query and commit)
          throw Object.assign(new Error("ABORT_INELIGIBLE"), { isAbortIneligible: true });
        }

        const data = current.data() as Record<string, unknown>;
        const custody = (data["chainOfCustody"] ?? []) as ChainOfCustodyEntry[];

        let integritySnapshot: string | null = null;
        try {
          const docData = { ...data };
          docData["createdAt"] = deserializeFirestoreDate(docData["createdAt"], "createdAt");
          integritySnapshot = computeIntegritySnapshot(docData as unknown as EvidenceDocument);
        } catch { /* non-fatal */ }

        const entry: ChainOfCustodyEntry = {
          action: "status_changed",
          performedBy: "cloud_function",
          timestamp: new Date(),
          evidenceId,
          metadata: { priorStatus: currentStatus, newStatus: "expired" },
          integritySnapshot,
        };

        tx.update(docSnap.ref, {
          status: "expired",
          chainOfCustody: [...custody, entry],
          updatedAt: new Date(),
        });
      });
      result.succeeded++;
    } catch (e) {
      if ((e as { isAbortIneligible?: boolean }).isAbortIneligible) {
        logger.info(`[processEvidenceExpiry] Skipped ${evidenceId} — status changed concurrently`);
        result.processed--;
        continue;
      }
      logger.error(
        `[processEvidenceExpiry] Failed to expire ${evidenceId}: ${(e as Error).message}`
      );
      result.failed++;
    }
  }

  logger.info(
    `[processEvidenceExpiry] Run complete: ${result.processed} processed, ` +
      `${result.succeeded} expired, ${result.failed} failed`
  );
  return result;
}

export function createProcessEvidenceExpiryHandler(
  db: Firestore,
  logger: PipelineLogger
) {
  return async (): Promise<ExpiryRunResult> => runProcessEvidenceExpiry(db, logger);
}
