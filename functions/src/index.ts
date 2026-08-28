/**
 * RAKSHA Evidence Trail — Cloud Functions entry point
 *
 * Registers all Cloud Functions:
 *  - onEvidenceCreate: Firestore trigger
 *  - reportUploadFailure, retriggerProcessing: https.onCall
 *  - serveEvidenceFile: https.onCall
 *  - setLegalHold, releaseLegalHold, grantEvidenceAccess, revokeEvidenceAccess, recordEvidenceViewed: https.onCall
 *  - generateLegalExport: https.onCall
 */
import * as functions from "firebase-functions";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { initializeApp, getApps } from "firebase-admin/app";
import { createOnEvidenceCreate } from "./functions/onEvidenceCreate/index.js";
import { createKMSClient } from "./kms/createKMSClient.js";
import { runReportUploadFailure } from "./functions/reportUploadFailure.js";
import { runRetriggerProcessing } from "./functions/retriggerProcessing.js";
import {
  runSetLegalHold,
  runReleaseLegalHold,
  runGrantEvidenceAccess,
  runRevokeEvidenceAccess,
  runRecordEvidenceViewed,
} from "./functions/accessControl.js";
import { createServeEvidenceFileHandler } from "./functions/serveEvidenceFile.js";
import {
  createGenerateLegalExportHandler,
  type GenerateLegalExportRequest,
} from "./functions/generateLegalExport.js";
import { createCloudTasksClient } from "./cloudTasks/createCloudTasksClient.js";
import { createCreateSOSSessionHandler } from "./functions/createSOSSession.js";
import { createActivateSOSSessionHandler } from "./functions/activateSOSSession.js";
import { createCancelSOSSessionHandler } from "./functions/cancelSOSSession.js";
import { createTestTriggerHandler } from "./functions/testTrigger.js";
import type { CreateSOSSessionPayload } from "./types/sosSession.js";
import { runOnSOSSessionUpdate } from "./functions/onSOSSessionUpdate.js";
import { createRespondToGuardianPingHandler } from "./functions/respondToGuardianPing.js";
import { lookupUserByEmailHandler } from "./functions/lookupUserByEmail.js";

// Initialize Firebase Admin exactly once
if (getApps().length === 0) {
  initializeApp();
}

// Storage bucket — must match VITE_FIREBASE_STORAGE_BUCKET in the client config.
// Operator-precedence note: parenthesise the ?? fallback explicitly.
const storageBucketName =
  process.env.FIREBASE_STORAGE_BUCKET
  ?? (process.env.GCLOUD_PROJECT
      ? `${process.env.GCLOUD_PROJECT}.firebasestorage.app`
      : "raksha-2d407.firebasestorage.app");

function getBucket() {
  return getStorage().bucket(storageBucketName);
}

// Module-level KMS client singleton
const kms = createKMSClient();
const keyRingRef = process.env.KMS_KEY_RING_REF ?? "";

// Module-level Cloud Tasks client
const cloudTasksClient = createCloudTasksClient();
const queuePath = process.env.ACTIVATION_QUEUE_PATH ?? "";
const handlerUrl = process.env.ACTIVATION_HANDLER_URL ?? "";

// Export onEvidenceCreate trigger — pass shared kms and bucket so
// KMSMock's in-memory DEK store is the same instance used by
// serveEvidenceFile and generateLegalExport.
export const onEvidenceCreate = createOnEvidenceCreate(kms, getBucket());

// reportUploadFailure
export const reportUploadFailure = functions.https.onCall(
  async (data: { evidenceId: string }, context) => {
    const result = await runReportUploadFailure(
      data.evidenceId,
      context.auth?.uid ?? "",
      getFirestore()
    );
    return result;
  }
);

// retriggerProcessing
export const retriggerProcessing = functions.https.onCall(
  async (data: { evidenceId: string }, context) => {
    const result = await runRetriggerProcessing(
      data.evidenceId,
      context.auth?.uid ?? "",
      getFirestore(),
      getBucket(),
      kms,
      functions.logger
    );
    return result;
  }
);

// setLegalHold
export const setLegalHold = functions.https.onCall(
  async (data: { evidenceId: string; legalHoldReason: string }, context) => {
    await runSetLegalHold(
      data.evidenceId,
      context.auth?.uid ?? "",
      data.legalHoldReason,
      getFirestore()
    );
    return { success: true };
  }
);

// releaseLegalHold
export const releaseLegalHold = functions.https.onCall(
  async (data: { evidenceId: string }, context) => {
    await runReleaseLegalHold(
      data.evidenceId,
      context.auth?.uid ?? "",
      getFirestore()
    );
    return { success: true };
  }
);

// grantEvidenceAccess
export const grantEvidenceAccess = functions.https.onCall(
  async (data: { evidenceId: string; contactUid: string }, context) => {
    await runGrantEvidenceAccess(
      data.evidenceId,
      context.auth?.uid ?? "",
      data.contactUid,
      getFirestore()
    );
    return { success: true };
  }
);

// revokeEvidenceAccess
export const revokeEvidenceAccess = functions.https.onCall(
  async (data: { evidenceId: string; contactUid: string }, context) => {
    await runRevokeEvidenceAccess(
      data.evidenceId,
      context.auth?.uid ?? "",
      data.contactUid,
      getFirestore()
    );
    return { success: true };
  }
);

// recordEvidenceViewed
export const recordEvidenceViewed = functions.https.onCall(
  async (data: { evidenceId: string }, context) => {
    await runRecordEvidenceViewed(
      data.evidenceId,
      context.auth?.uid ?? "",
      getFirestore()
    );
    return { success: true };
  }
);

// serveEvidenceFile
const serveEvidenceFileHandler = createServeEvidenceFileHandler(
  getFirestore(),
  getBucket(),
  kms,
  functions.logger,
  keyRingRef
);

export const serveEvidenceFile = functions.https.onCall(
  async (data: { evidenceId: string }, context) => {
    return serveEvidenceFileHandler(data, context);
  }
);

// generateLegalExport
const generateLegalExportHandler = createGenerateLegalExportHandler(
  getFirestore(),
  getBucket(),
  kms,
  functions.logger,
  keyRingRef
);

export const generateLegalExport = functions.https.onCall(
  async (data: GenerateLegalExportRequest, context) => {
    return generateLegalExportHandler(data, context);
  }
);

// createSOSSession
const createSOSSessionHandler = createCreateSOSSessionHandler(
  getFirestore(),
  cloudTasksClient,
  queuePath,
  handlerUrl
);

export const createSOSSession = functions.https.onCall(
  async (data: CreateSOSSessionPayload, context) => {
    return createSOSSessionHandler(data, context);
  }
);

// activateSOSSession — Cloud Tasks HTTP handler (NOT callable; invoked by Cloud Tasks only)
// Cloud Tasks delivers an HTTP POST; the handler verifies X-CloudTasks-QueueName header.
export const activateSOSSession = functions.https.onRequest(
  createActivateSOSSessionHandler(getFirestore())
);

// cancelSOSSession — HTTPS callable Cloud Function.
export const cancelSOSSession = functions.https.onCall(
  async (data: { sessionId: string }, context) => {
    const handler = createCancelSOSSessionHandler(getFirestore());
    return handler(data, context);
  }
);

// testTrigger — HTTPS callable Cloud Function.
export const testTrigger = functions.https.onCall(
  async (data: CreateSOSSessionPayload, context) => {
    const handler = createTestTriggerHandler();
    return handler(data, context);
  }
);

// onSOSSessionUpdate — Firestore database trigger.
export const onSOSSessionUpdate = functions.firestore
  .document("sosSessions/{sessionId}")
  .onUpdate(async (change, context) => {
    return runOnSOSSessionUpdate(change, getFirestore());
  });

// respondToGuardianPing — HTTPS callable Cloud Function.
export const respondToGuardianPing = functions.https.onCall(
  createRespondToGuardianPingHandler(getFirestore())
);

// lookupUserByEmail — HTTPS callable Cloud Function.
// Used by TrustedContactsScreen to link a contact's email to their RAKSHA UID.
export const lookupUserByEmail = lookupUserByEmailHandler;
