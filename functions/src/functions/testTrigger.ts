/**
 * testTrigger — HTTPS callable Cloud Function.
 *
 * Runs the same payload validation as createSOSSession, but writes nothing
 * to Firestore, enqueues no tasks, and triggers no notifications.
 *
 * Used exclusively by the client in "test mode" to verify gesture,
 * phrase, or duress-PIN triggers without arming a real emergency session.
 *
 * Requirements: design.md §testTrigger, tasks.md Task 5
 */
import crypto from "crypto";
import * as functions from "firebase-functions";
import { parseISODate } from "../utils/assertDate.js";
import type {
  CreateSOSSessionPayload,
  CreateSOSSessionResponse,
} from "../types/sosSession.js";
import { TRIGGER_TYPES } from "../types/sosSession.js";

/**
 * Runs the testTrigger logic. Separated from function registration for testing.
 */
export async function runTestTrigger(
  payload: CreateSOSSessionPayload,
  callerUid: string,
  serverTimeOverride?: Date
): Promise<CreateSOSSessionResponse> {
  const serverReceiveTime = serverTimeOverride ?? new Date();

  // Step 1 — Auth check
  if (!callerUid) {
    throw Object.assign(new Error("testTrigger: unauthenticated"), {
      code: "UNAUTHENTICATED",
    });
  }

  // Step 2 — Validate payload structure
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new Error("testTrigger: missing or invalid payload"), {
      code: "INVALID_ARGUMENT",
    });
  }

  // Step 3 — Parse and validate timestamps (same rules as createSOSSession)
  let triggeredAt: Date;
  let syncedAt: Date;
  try {
    triggeredAt = parseISODate(payload.triggeredAt, "triggeredAt");
  } catch (e: any) {
    throw Object.assign(new Error(`testTrigger: ${e.message}`), {
      code: "INVALID_ARGUMENT",
    });
  }

  try {
    syncedAt = parseISODate(payload.syncedAt, "syncedAt");
  } catch (e: any) {
    throw Object.assign(new Error(`testTrigger: ${e.message}`), {
      code: "INVALID_ARGUMENT",
    });
  }

  const serverReceiveMs = serverReceiveTime.getTime();
  const triggeredMs = triggeredAt.getTime();

  // Reject future triggeredAt with 5s tolerance
  if (triggeredMs > serverReceiveMs + 5000) {
    throw Object.assign(
      new Error(
        `testTrigger: triggeredAt is in the future (triggeredAt: ${payload.triggeredAt}, server: ${serverReceiveTime.toISOString()})`
      ),
      { code: "INVALID_ARGUMENT" }
    );
  }

  // Reject triggeredAt older than 72 hours
  const seventyTwoHoursMs = 72 * 3600 * 1000;
  if (triggeredMs < serverReceiveMs - seventyTwoHoursMs) {
    throw Object.assign(
      new Error(
        `testTrigger: triggeredAt is older than 72 hours (triggeredAt: ${payload.triggeredAt})`
      ),
      { code: "INVALID_ARGUMENT" }
    );
  }

  // Step 4 — Validate triggerType
  const triggerType = payload.triggerType;
  if (!TRIGGER_TYPES.includes(triggerType)) {
    throw Object.assign(
      new Error("testTrigger: invalid triggerType"),
      { code: "INVALID_ARGUMENT" }
    );
  }

  // Step 5 — Abuse monitoring audit log (same format as createSOSSession, no raw userId)
  const hashedUid = crypto.createHash("sha256").update(callerUid).digest("hex").slice(0, 16);
  const triggeredAtIso = triggeredAt.toISOString().split(".")[0] + "Z";
  const createdAtIso = serverReceiveTime.toISOString().split(".")[0] + "Z";

  functions.logger.info({
    message: "testTrigger audit log",
    userId: hashedUid,
    triggerType,
    triggeredAt: triggeredAtIso,
    createdAt: createdAtIso,
  });

  // Step 6 — Return synthesized countdown response (no Firestore writes, no Cloud Tasks)
  const sessionId = `test_${crypto.randomUUID()}`;
  return {
    sessionId,
    status: "countdown",
    alreadyExists: false,
  };
}

/**
 * Creates the Cloud Function callable handler.
 */
export function createTestTriggerHandler() {
  return async (
    data: CreateSOSSessionPayload,
    context: functions.https.CallableContext
  ): Promise<CreateSOSSessionResponse> => {
    const callerUid = context.auth?.uid ?? "";
    return runTestTrigger(data, callerUid);
  };
}
