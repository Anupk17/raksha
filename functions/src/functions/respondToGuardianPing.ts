/**
 * respondToGuardianPing — HTTPS Callable Cloud Function.
 *
 * Allows a verified guardian to accept or decline an active SOS session ping.
 * Updates the ping document and recalculates the guardian's response stats using
 * the transactional incremental mean formula.
 *
 * Requirements: Technical Design — Hyperlocal Guardian Network
 */
import type { Firestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { deserializeFirestoreDate } from "../utils/assertDate.js";
import type { Guardian, GuardianPing } from "../types/guardian.js";

export interface RespondToGuardianPingPayload {
  pingId: string;
  response: "accepted" | "declined";
}

export interface RespondToGuardianPingResponse {
  success: boolean;
  alreadyResponded?: boolean;
}

/**
 * Core transactional logic for recording a guardian's ping response.
 */
export async function runRespondToGuardianPing(
  payload: RespondToGuardianPingPayload,
  callerUid: string,
  db: Firestore
): Promise<RespondToGuardianPingResponse> {
  // Step 1 — Authenticate caller
  if (!callerUid) {
    throw Object.assign(new Error("respondToGuardianPing: unauthenticated"), {
      code: "UNAUTHENTICATED",
    });
  }

  // Step 2 — Validate payload structure
  if (!payload || typeof payload !== "object" || !payload.pingId || !payload.response) {
    throw Object.assign(new Error("respondToGuardianPing: missing or invalid payload"), {
      code: "INVALID_ARGUMENT",
    });
  }

  if (payload.response !== "accepted" && payload.response !== "declined") {
    throw Object.assign(new Error("respondToGuardianPing: invalid response value"), {
      code: "INVALID_ARGUMENT",
    });
  }

  const { pingId, response } = payload;
  const pingRef = db.collection("guardian_pings").doc(pingId);
  const guardianRef = db.collection("guardians").doc(callerUid);

  let alreadyResponded = false;

  // Step 3 — Perform updates inside a Firestore transaction
  await db.runTransaction(async (tx) => {
    const pingDoc = await tx.get(pingRef);
    if (!pingDoc.exists) {
      throw Object.assign(new Error("respondToGuardianPing: ping document not found"), {
        code: "NOT_FOUND",
      });
    }

    const pingData = pingDoc.data() as GuardianPing;

    // Confirm that the caller is indeed the guardian assigned to this ping
    if (pingData.guardianId !== callerUid) {
      throw Object.assign(new Error("respondToGuardianPing: permission denied"), {
        code: "PERMISSION_DENIED",
      });
    }

    // Idempotency: if already responded, return success immediately
    if (pingData.respondedAt !== null) {
      alreadyResponded = true;
      return;
    }

    const respondedAt = new Date();
    const sentAt = deserializeFirestoreDate(pingData.sentAt, "sentAt");

    // Calculate response time in seconds
    const responseTimeSeconds = (respondedAt.getTime() - sentAt.getTime()) / 1000;

    // Fetch the guardian document to update stats
    const guardianDoc = await tx.get(guardianRef);
    if (!guardianDoc.exists) {
      throw Object.assign(new Error("respondToGuardianPing: guardian profile not found"), {
        code: "NOT_FOUND",
      });
    }

    const guardianData = guardianDoc.data() as Guardian;

    const oldStats = guardianData.responseStats ?? {
      totalPings: 0,
      respondedCount: 0,
      avgResponseTimeSeconds: 0,
    };

    const oldAvg = oldStats.avgResponseTimeSeconds ?? 0;
    const oldRespondedCount = oldStats.respondedCount ?? 0;
    const oldTotalPings = oldStats.totalPings ?? 0;

    // Recalculate incremental mean response time
    const newAvg = oldAvg + (responseTimeSeconds - oldAvg) / (oldRespondedCount + 1);

    const newStats = {
      totalPings: oldTotalPings + 1,
      respondedCount: oldRespondedCount + 1,
      avgResponseTimeSeconds: newAvg,
    };

    // Commit writes inside transaction
    tx.update(pingRef, {
      response,
      respondedAt,
    });

    tx.update(guardianRef, {
      responseStats: newStats,
    });
  });

  if (alreadyResponded) {
    return { success: true, alreadyResponded: true };
  }

  // Step 4 — Emit structured audit log
  functions.logger.info({
    message: "respondToGuardianPing audit log",
    pingId,
    guardianId: callerUid.slice(0, 8) + "...", // partially obfuscated
    response,
  });

  return { success: true };
}

/**
 * Creates the Cloud Function handler.
 */
export function createRespondToGuardianPingHandler(db: Firestore) {
  return async (
    data: RespondToGuardianPingPayload,
    context: functions.https.CallableContext
  ): Promise<RespondToGuardianPingResponse> => {
    const callerUid = context.auth?.uid ?? "";
    return runRespondToGuardianPing(data, callerUid, db);
  };
}
