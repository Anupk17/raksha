/**
 * activateSOSSession — Cloud Tasks HTTP handler.
 *
 * Performs the conditional `countdown → active` status transition for an
 * SOSSession document. This function is invoked by the Cloud Tasks queue
 * (not by clients directly) 10 seconds after createSOSSession enqueues the
 * task.
 *
 * ## Response semantics
 *
 * Cloud Tasks interprets HTTP responses as follows:
 *   2xx → task succeeded, do NOT retry
 *   5xx → task failed, retry per the queue's retry policy
 *
 * We exploit this deliberately:
 *   - Non-countdown status (cancelled, active) → 200 (intentional no-op)
 *   - Missing session document              → 200 (orphan task, safe to discard;
 *       see createSOSSession.ts for the Task 2 integrity guarantee: enqueue
 *       can succeed while the Firestore write fails)
 *   - Firestore transient error             → 500 (Cloud Tasks will retry)
 *   - Bad request (wrong queue header)      → 400 (do not retry)
 *
 * ## Timestamp discipline
 *
 * All timestamp fields read from Firestore are deserialized through
 * deserializeFirestoreDate / assertDateOrNull from utils/assertDate.ts.
 * No raw `new Date(firestoreValue)` calls are made.
 *
 * Requirements: design.md §activateSOSSession, tasks.md Task 3
 */
import type { Firestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import type { Request, Response } from "express";
import {
  deserializeFirestoreDate,
  assertDateOrNull,
} from "../utils/assertDate.js";

/** Sentinel thrown inside the Firestore transaction to signal a clean abort. */
const ABORT_NOT_COUNTDOWN = "ABORT_NOT_COUNTDOWN";
/** Sentinel thrown when the session document is absent (orphan Cloud Task). */
const ABORT_NOT_FOUND = "ABORT_NOT_FOUND";

/**
 * Runs the activateSOSSession logic. Separated from Express handler for testing.
 *
 * @param sessionId  - The session ID extracted from the Cloud Tasks payload.
 * @param db         - Firestore instance (injectable for testing).
 * @param serverTimeOverride - Optional fixed "now" for deterministic tests.
 * @returns An object describing the outcome, to be mapped to an HTTP status.
 */
export async function runActivateSOSSession(
  sessionId: string,
  db: Firestore,
  serverTimeOverride?: Date
): Promise<{
  outcome: "activated" | "not_countdown" | "not_found" | "error";
  status?: string;
  error?: string;
}> {
  if (!sessionId || typeof sessionId !== "string") {
    return { outcome: "error", error: "sessionId missing or not a string" };
  }

  const sessionRef = db.collection("sosSessions").doc(sessionId);

  try {
    let outcome: "activated" | "not_countdown" | "not_found" = "activated";

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(sessionRef);

      // Gracefully handle orphan tasks (enqueue succeeded, Firestore write failed).
      // Return 200 to Cloud Tasks so it doesn't retry an unresolvable task.
      if (!doc.exists) {
        functions.logger.warn({
          message: "activateSOSSession: session document not found (orphan task)",
          sessionId,
        });
        outcome = "not_found";
        return; // abort transaction, no write
      }

      const data = doc.data()!;

      // Deserialize all timestamps at the Firestore boundary — no raw Date() calls.
      const triggeredAt = deserializeFirestoreDate(data["triggeredAt"], "triggeredAt");
      const createdAt   = deserializeFirestoreDate(data["createdAt"], "createdAt");
      const activatedAt = assertDateOrNull(data["activatedAt"], "activatedAt");
      const cancelledAt = assertDateOrNull(data["cancelledAt"], "cancelledAt");

      // Log the deserialized values for auditing (suppress unused-var warnings).
      void triggeredAt; void createdAt; void activatedAt; void cancelledAt;

      const currentStatus = data["status"] as string;

      if (currentStatus !== "countdown") {
        // cancelSOSSession already committed, or this task fired twice.
        // Either is fine — abort without writing, return 200 to Cloud Tasks.
        functions.logger.info({
          message: `activateSOSSession aborted: status=${currentStatus}`,
          sessionId,
          actualStatus: currentStatus,
        });
        outcome = "not_countdown";
        return;
      }

      // Conditional write: status + activatedAt + updatedAt are written atomically.
      // If another transaction (e.g. cancelSOSSession) committed between our read
      // and this write, Firestore will abort and retry this transaction automatically.
      const now = serverTimeOverride ?? new Date();
      tx.update(sessionRef, {
        status: "active",
        activatedAt: now,
        updatedAt: now,
      });
    });

    if (outcome === "activated") {
      functions.logger.info({
        message: "activateSOSSession: countdown → active",
        sessionId,
      });
    }

    return { outcome };
  } catch (err: any) {
    // Firestore transient error (network, contention not resolved within retries).
    // Rethrow so the HTTP handler returns 500 and Cloud Tasks retries.
    functions.logger.error({
      message: "activateSOSSession: Firestore error",
      sessionId,
      error: err.message,
    });
    return { outcome: "error", error: err.message };
  }
}

/**
 * Creates an Express-compatible HTTP handler for the Cloud Tasks queue.
 * Registered as an HTTPS function (not callable) in index.ts.
 */
export function createActivateSOSSessionHandler(db: Firestore) {
  return async (req: Request, res: Response): Promise<void> => {
    // Step 1 — Verify request origin via the Cloud Tasks sentinel header.
    // Cloud Tasks always sets X-CloudTasks-QueueName on delivery. A request
    // lacking this header is not from Cloud Tasks and must be rejected.
    const queueName = req.headers["x-cloudtasks-queuename"];
    if (!queueName) {
      functions.logger.warn({
        message: "activateSOSSession: request missing X-CloudTasks-QueueName header",
        ip: req.ip,
      });
      res.status(400).json({ error: "Missing Cloud Tasks header" });
      return;
    }

    // Step 2 — Parse payload.
    const body = req.body as Record<string, unknown>;
    const sessionId = body?.sessionId as string | undefined;

    if (!sessionId || typeof sessionId !== "string") {
      functions.logger.warn({
        message: "activateSOSSession: missing or invalid sessionId in payload",
        queueName,
      });
      // 400 → Cloud Tasks will NOT retry (bad payload, retrying won't fix it).
      res.status(400).json({ error: "Missing sessionId" });
      return;
    }

    // Step 3 — Run the activation logic.
    const result = await runActivateSOSSession(sessionId, db);

    switch (result.outcome) {
      case "activated":
      case "not_countdown":
      case "not_found":
        // All intentional no-op paths → 200. Cloud Tasks will not retry.
        res.status(200).json({ outcome: result.outcome });
        return;

      case "error":
        // Transient failure → 500. Cloud Tasks will retry per the retry policy.
        res.status(500).json({ error: result.error });
        return;
    }
  };
}
