/**
 * cancelSOSSession — HTTPS callable Cloud Function.
 *
 * Performs the conditional `countdown → cancelled` status transition for an
 * SOSSession document. Called by the client during the 10-second countdown
 * window to abort the SOS escalation.
 *
 * ## Atomicity guarantee
 *
 * Unlike createSOSSession (which has a Cloud Tasks enqueue outside the
 * Firestore transaction), cancelSOSSession has NO external side effects.
 * The entire state change — status, cancelledAt, updatedAt — lands in a
 * single tx.update() call inside one Firestore transaction. There is no
 * two-write gap to protect against.
 *
 * Crash scenarios:
 *   - Crash before transaction commits → no write, client retries, clean.
 *   - Crash after transaction commits, before response → client retries,
 *     ALREADY_CANCELLED path returns { cancelled: true, alreadyWas: true }.
 *   - Race vs activateSOSSession → whichever commits first wins. If
 *     activateSOSSession wins, cancelSOSSession returns ALREADY_ESCALATED (409).
 *
 * ## 3-second confirmation SLA (Req 7)
 *
 * This function makes zero external calls (no Cloud Tasks, no KMS, no HTTP).
 * It is a single Firestore transaction read + conditional update.
 * No deliberate delays are introduced. The 3-second SLA is satisfied by
 * construction as long as Firestore p95 latency stays under that budget.
 *
 * ## Ownership check placement
 *
 * The design.md spec reads ownership from a document read outside the
 * transaction and then re-reads inside (two Firestore reads). This
 * implementation merges both into one tx.get() — the ownership check and
 * status check happen atomically. userId never changes post-creation, so
 * this is semantically equivalent but cheaper.
 *
 * Requirements: design.md §cancelSOSSession, tasks.md Task 4
 */
import type { Firestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import {
  deserializeFirestoreDate,
  assertDateOrNull,
} from "../utils/assertDate.js";

export interface CancelSOSSessionResponse {
  cancelled: boolean;
  alreadyWas?: boolean;
  reason?: string;
}

/**
 * Runs the cancelSOSSession logic. Separated from function registration for testing.
 *
 * @param sessionId  - The session to cancel.
 * @param callerUid  - The authenticated user's UID.
 * @param db         - Firestore instance (injectable for testing).
 * @param serverTimeOverride - Optional fixed "now" for deterministic tests.
 */
export async function runCancelSOSSession(
  sessionId: string,
  callerUid: string,
  db: Firestore,
  serverTimeOverride?: Date
): Promise<CancelSOSSessionResponse> {
  // Step 1 — Auth check
  if (!callerUid) {
    throw Object.assign(new Error("cancelSOSSession: unauthenticated"), {
      code: "UNAUTHENTICATED",
    });
  }

  if (!sessionId || typeof sessionId !== "string") {
    throw Object.assign(new Error("cancelSOSSession: missing sessionId"), {
      code: "INVALID_ARGUMENT",
    });
  }

  const sessionRef = db.collection("sosSessions").doc(sessionId);
  let response: CancelSOSSessionResponse | null = null;

  // Step 2+3 — Ownership check + conditional transaction, merged into one read.
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(sessionRef);

    if (!doc.exists) {
      throw Object.assign(
        new Error(`cancelSOSSession: session '${sessionId}' not found`),
        { code: "NOT_FOUND" }
      );
    }

    const data = doc.data()!;

    // Deserialize all timestamps at the Firestore boundary.
    // assertDateOrNull / deserializeFirestoreDate throw loudly on
    // non-Date values — consistent with all other SOSSession readers.
    const triggeredAt = deserializeFirestoreDate(data["triggeredAt"], "triggeredAt");
    const createdAt = deserializeFirestoreDate(data["createdAt"], "createdAt");
    const cancelledAt = assertDateOrNull(data["cancelledAt"], "cancelledAt");
    const activatedAt = assertDateOrNull(data["activatedAt"], "activatedAt");
    void triggeredAt; void createdAt; void cancelledAt; void activatedAt;

    // Ownership check — inside the transaction so it reads a consistent snapshot.
    const ownerId = data["userId"] as string;
    if (ownerId !== callerUid) {
      throw Object.assign(
        new Error("cancelSOSSession: caller does not own this session"),
        { code: "PERMISSION_DENIED" }
      );
    }

    const status = data["status"] as string;

    // --- Status dispatch ---

    if (status === "cancelled") {
      // Idempotent re-cancel: session is already in the desired terminal state.
      // No write needed — return success to the client.
      functions.logger.info({
        message: "cancelSOSSession: already cancelled (idempotent re-cancel)",
        sessionId,
      });
      response = { cancelled: true, alreadyWas: true };
      return;
    }

    if (status === "active") {
      // activateSOSSession already committed. Cancel is no longer possible.
      // Throw to signal 409 to the callable wrapper — do NOT write (P26).
      functions.logger.info({
        message: "cancelSOSSession: session already active (ALREADY_ESCALATED)",
        sessionId,
      });
      throw Object.assign(
        new Error("cancelSOSSession: session already escalated to active"),
        { code: "ALREADY_ESCALATED" }
      );
    }

    if (status !== "countdown") {
      // Unexpected terminal status (e.g. enqueue_failed or unknown).
      throw Object.assign(
        new Error(`cancelSOSSession: unexpected status '${status}' for session '${sessionId}'`),
        { code: "INTERNAL" }
      );
    }

    // --- Conditional write: countdown → cancelled ---
    //
    // All three fields land in a single tx.update() — atomic, no observable
    // intermediate state. Contrast with Evidence Trail's original P25 bug where
    // status and a second field were written in separate operations.
    const now = serverTimeOverride ?? new Date();
    tx.update(sessionRef, {
      status: "cancelled",
      cancelledAt: now,
      updatedAt: now,
    });

    functions.logger.info({
      message: "cancelSOSSession: countdown → cancelled",
      sessionId,
    });

    response = { cancelled: true, alreadyWas: false };
  });

  return response!;
}

/**
 * Creates the Cloud Function callable handler.
 */
export function createCancelSOSSessionHandler(db: Firestore) {
  return async (
    data: { sessionId: string },
    context: functions.https.CallableContext
  ): Promise<CancelSOSSessionResponse> => {
    const callerUid = context.auth?.uid ?? "";
    try {
      return await runCancelSOSSession(data.sessionId, callerUid, db);
    } catch (err: any) {
      // Re-surface ALREADY_ESCALATED as a structured error the client can
      // distinguish from an internal failure. Other error codes propagate as-is.
      if (err.code === "ALREADY_ESCALATED") {
        throw Object.assign(err, {
          details: { cancelled: false, reason: "ALREADY_ESCALATED" },
        });
      }
      throw err;
    }
  };
}
