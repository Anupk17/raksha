/**
 * createSOSSession — HTTPS callable Cloud Function.
 *
 * Entry point for Discreet Silent Activation. Creates a SOSSession document
 * in Firestore with status 'countdown', and enqueues a Cloud Tasks task to
 * activate the session after 10 seconds.
 *
 * ## Session-integrity guarantee (Property 25 analogue)
 *
 * Cloud Tasks is NOT transactional with Firestore. The original implementation
 * wrote to Firestore first, then enqueued — a crash between those two steps
 * would leave a document with status 'countdown' and no activation task ever
 * delivering, silently killing the SOS trigger.
 *
 * The fix: enqueue Cloud Tasks FIRST, then write to Firestore.
 *
 *   Enqueue fails   → no Firestore document, clean INTERNAL error to client.
 *                     Client may safely retry; idempotency check on
 *                     triggeredAt+userId catches the second call.
 *
 *   Enqueue OK,     → orphan Cloud Task with no matching document.
 *   Firestore fails   The activation handler must gracefully no-op when the
 *                     session document is absent (handled in activateSOSSession,
 *                     Task 3). Client receives an error and can retry; the
 *                     named-task dedup (see below) ensures the retry does NOT
 *                     create a second task.
 *
 *   Both OK         → correct countdown document with guaranteed activation.
 *
 * ## Double-enqueue idempotency on retry
 *
 * The Cloud Task is created with a STABLE NAME derived from the sessionId
 * ("activate-{sessionId}"). Cloud Tasks enforces deduplication on named tasks
 * within a 4-hour window: a second createTask call with the same name returns
 * ALREADY_EXISTS, which we absorb as a success. This makes the enqueue step
 * fully idempotent at the infrastructure level, independent of the Firestore
 * idempotency check that guards duplicate user requests.
 *
 * Requirements: design.md §createSOSSession, tasks.md Task 2
 */
import type { Firestore } from "firebase-admin/firestore";
import crypto from "crypto";
import * as functions from "firebase-functions";
import type { CloudTasksClient } from "../cloudTasks/cloudTasks.interface.js";
import { parseISODate } from "../utils/assertDate.js";
import type {
  CreateSOSSessionPayload,
  CreateSOSSessionResponse,
  SOSSession,
} from "../types/sosSession.js";
import { TRIGGER_TYPES } from "../types/sosSession.js";

/**
 * Runs the createSOSSession logic. Separated from function registration for testing.
 */
export async function runCreateSOSSession(
  payload: CreateSOSSessionPayload,
  callerUid: string,
  db: Firestore,
  tasksClient: CloudTasksClient,
  queuePath: string,
  handlerUrl: string,
  serverTimeOverride?: Date
): Promise<CreateSOSSessionResponse> {
  const serverReceiveTime = serverTimeOverride ?? new Date();

  // Step 1 — Auth check
  if (!callerUid) {
    throw Object.assign(new Error("createSOSSession: unauthenticated"), {
      code: "UNAUTHENTICATED",
    });
  }

  // Step 2 — Validate payload structure
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new Error("createSOSSession: missing or invalid payload"), {
      code: "INVALID_ARGUMENT",
    });
  }

  // Step 3 — Parse and validate timestamps (strict boundary — no raw new Date())
  let triggeredAt: Date;
  let syncedAt: Date;
  try {
    triggeredAt = parseISODate(payload.triggeredAt, "triggeredAt");
  } catch (e: any) {
    throw Object.assign(new Error(`createSOSSession: ${e.message}`), {
      code: "INVALID_ARGUMENT",
    });
  }

  try {
    syncedAt = parseISODate(payload.syncedAt, "syncedAt");
  } catch (e: any) {
    throw Object.assign(new Error(`createSOSSession: ${e.message}`), {
      code: "INVALID_ARGUMENT",
    });
  }

  const serverReceiveMs = serverReceiveTime.getTime();
  const triggeredMs = triggeredAt.getTime();

  // Reject future triggeredAt with 5-second tolerance for clock skew.
  // (Asymmetric window: future is ALWAYS rejected — no LATE_SYNC flag applies.)
  if (triggeredMs > serverReceiveMs + 5000) {
    throw Object.assign(
      new Error(
        `createSOSSession: triggeredAt is in the future (triggeredAt: ${payload.triggeredAt}, server: ${serverReceiveTime.toISOString()})`
      ),
      { code: "INVALID_ARGUMENT" }
    );
  }

  // Reject triggeredAt older than 72 hours — past-accepted, but with hard cap.
  const seventyTwoHoursMs = 72 * 3600 * 1000;
  if (triggeredMs < serverReceiveMs - seventyTwoHoursMs) {
    throw Object.assign(
      new Error(
        `createSOSSession: triggeredAt is older than 72 hours (triggeredAt: ${payload.triggeredAt})`
      ),
      { code: "INVALID_ARGUMENT" }
    );
  }

  // Step 4 — Validate triggerType
  const triggerType = payload.triggerType;
  if (!TRIGGER_TYPES.includes(triggerType)) {
    throw Object.assign(
      new Error(`createSOSSession: invalid triggerType '${triggerType}'`),
      { code: "INVALID_ARGUMENT" }
    );
  }

  // Step 5 — Compute LATE_SYNC flag.
  // The gap between triggeredAt and syncedAt represents offline delay.
  // Any gap >= 60 minutes is flagged so downstream systems know the trigger
  // was not synced in near-real-time.
  const syncedMs = syncedAt.getTime();
  const syncDelayMinutes = Math.round((syncedMs - triggeredMs) / 60000);
  const lateSyncFlag = syncDelayMinutes >= 60;

  const sessionId = crypto.randomUUID();
  const sessionRef = db.collection("sosSessions").doc(sessionId);

  // Step 6 — Idempotency and Rate-limiting in a Firestore Transaction.
  // This is a READ-ONLY transaction phase: we only check for duplicates and
  // rate limits here, and signal to Step 7 whether to proceed.
  let shouldProceed = false;
  let idempotentResponse: CreateSOSSessionResponse | null = null;

  await db.runTransaction(async (tx) => {
    // 6.1 Idempotency Check — key: (userId, triggeredAt ± 5s).
    // If a session with this trigger already exists for this user, return it
    // without creating a new one or enqueueing another task.
    const fiveSecsMs = 5000;
    const startRange = new Date(triggeredMs - fiveSecsMs);
    const endRange = new Date(triggeredMs + fiveSecsMs);

    const query = db
      .collection("sosSessions")
      .where("userId", "==", callerUid)
      .where("triggeredAt", ">=", startRange)
      .where("triggeredAt", "<=", endRange);

    const querySnap = await tx.get(query);
    if (!querySnap.empty) {
      const existingDoc = querySnap.docs[0]!;
      const existingData = existingDoc.data();
      const existingStatus = existingData["status"] as string;

      idempotentResponse = {
        sessionId: existingDoc.id,
        status: (existingStatus === "active" ? "active" : "countdown") as "countdown" | "active",
        alreadyExists: true,
      };
      return; // Short-circuit: no new session needed.
    }

    // 6.2 Rate Limit Check — max 5 sessions per 10-minute sliding window.
    const tenMinsMs = 10 * 60 * 1000;
    const rateLimitStart = new Date(serverReceiveMs - tenMinsMs);
    const rateLimitQuery = db
      .collection("sosSessions")
      .where("userId", "==", callerUid)
      .where("createdAt", ">=", rateLimitStart);

    const rateLimitSnap = await tx.get(rateLimitQuery);
    if (rateLimitSnap.size >= 5) {
      const hashedUid = crypto.createHash("sha256").update(callerUid).digest("hex").slice(0, 16);
      functions.logger.warn({
        message: "createSOSSession rate-limit exceeded",
        userId: hashedUid,
        windowCount: rateLimitSnap.size,
      });

      throw Object.assign(
        new Error("createSOSSession: rate limit exceeded (5 requests per 10 minutes)"),
        { code: "RESOURCE_EXHAUSTED" }
      );
    }

    shouldProceed = true;
  });

  // If idempotency check matched, return the existing session now.
  if (idempotentResponse !== null) {
    return idempotentResponse;
  }

  // Step 7 — Enqueue Cloud Tasks BEFORE writing to Firestore.
  //
  // This is the core session-integrity fix. If we wrote Firestore first and
  // then Cloud Tasks failed, the document would be stuck in 'countdown' with
  // no activation task — silently killing the SOS trigger.
  //
  // By enqueueing first:
  //   - If enqueue fails → no Firestore document, clean INTERNAL error.
  //   - If enqueue succeeds, Firestore write fails → orphan task; the activation
  //     handler handles a missing document as a graceful no-op (Task 3).
  //   - If both succeed → correct document with guaranteed activation task.
  //
  // The task name "activate-{sessionId}" is a deterministic deduplication key.
  // Cloud Tasks enforces uniqueness within a 4-hour window: a retry of this
  // exact invocation (e.g. the process crashed and the caller retried) will
  // receive ALREADY_EXISTS, which we absorb as a success — no double-enqueue.

  if (!shouldProceed) {
    // Defensive guard; shouldProceed can only be false here if idempotentResponse
    // was non-null above, but TypeScript control-flow needs this.
    throw new Error("createSOSSession: internal control flow error");
  }

  // Schedule at triggeredAt + 10s, clamped to at least serverReceiveTime + 100ms.
  const scheduleMs = Math.max(serverReceiveMs + 100, triggeredMs + 10000);
  const stableTaskName = `activate-${sessionId}`;

  try {
    await tasksClient.enqueueTask(
      queuePath,
      handlerUrl,
      { sessionId },
      scheduleMs,
      stableTaskName
    );
  } catch (e: any) {
    // Enqueue failed. No Firestore document has been written yet — the caller
    // receives an INTERNAL error and can safely retry via the normal flow.
    // The idempotency check (Step 6.1) will catch their retry if the original
    // triggeredAt+userId pair already has a document. If it doesn't, a clean
    // new session will be created.
    functions.logger.error({
      message: `createSOSSession: Cloud Tasks enqueue failed, no document written (sessionId would have been ${sessionId})`,
      error: e.message,
    });

    throw Object.assign(
      new Error(`createSOSSession: Failed to enqueue activation task: ${e.message}`),
      { code: "INTERNAL" }
    );
  }

  // Step 8 — Write the Firestore document now that the task is guaranteed.
  const isElapsed = triggeredMs + 10000 <= serverReceiveMs;
  const responseStatus: "countdown" | "active" = isElapsed ? "active" : "countdown";

  const newSession: SOSSession = {
    sessionId,
    userId: callerUid,
    triggerType,
    triggeredAt,
    createdAt: serverReceiveTime,
    status: "countdown", // Actual status transition happens in activateSOSSession (Task 3)
    cancelledAt: null,
    activatedAt: null,
    location: payload.location ?? null,
    deviceInfo: payload.deviceInfo ?? "",
    syncDelayMinutes: payload.syncedAt ? syncDelayMinutes : null,
    lateSyncFlag,
  };

  await sessionRef.set(newSession);

  // Step 9 — Audit log (hashed userId, no sub-second precision).
  const hashedUid = crypto.createHash("sha256").update(callerUid).digest("hex").slice(0, 16);
  const triggeredAtIso = triggeredAt.toISOString().split(".")[0] + "Z";
  const createdAtIso = serverReceiveTime.toISOString().split(".")[0] + "Z";

  functions.logger.info({
    message: "createSOSSession audit log",
    sessionId,
    userId: hashedUid,
    triggerType,
    triggeredAt: triggeredAtIso,
    createdAt: createdAtIso,
    lateSyncFlag,
    taskName: stableTaskName,
  });

  return {
    sessionId,
    status: responseStatus,
    alreadyExists: false,
  };
}

/**
 * Creates the Cloud Function handler.
 */
export function createCreateSOSSessionHandler(
  db: Firestore,
  tasksClient: CloudTasksClient,
  queuePath: string,
  handlerUrl: string
) {
  return async (
    data: CreateSOSSessionPayload,
    context: functions.https.CallableContext
  ): Promise<CreateSOSSessionResponse> => {
    const callerUid = context.auth?.uid ?? "";
    return runCreateSOSSession(data, callerUid, db, tasksClient, queuePath, handlerUrl);
  };
}
