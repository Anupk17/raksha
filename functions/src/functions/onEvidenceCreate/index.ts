/**
 * onEvidenceCreate — Firestore onCreate trigger.
 *
 * Fires when a new document is created in /evidence/{evidenceId}.
 * Delegates all logic to runEvidenceCreatePipeline() so the pipeline
 * can be unit-tested and re-used by retriggerProcessing independently.
 *
 * The KMSClient is created at module initialization (not per-invocation)
 * so that KMSMock's in-memory key store persists across the lifecycle of
 * a single function execution — required for generateDataEncryptionKey +
 * decryptDataEncryptionKey to work on the same instance.
 *
 * Requirements: 3, 4, 5, 8, 10, 11
 * Design: §onEvidenceCreate Cloud Function Pipeline
 */
import * as functions from "firebase-functions";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { initializeApp, getApps } from "firebase-admin/app";
import { createKMSClient } from "../../kms/createKMSClient.js";
import { runEvidenceCreatePipeline } from "./pipeline.js";

// Ensure Firebase Admin is initialized exactly once.
if (getApps().length === 0) {
  initializeApp();
}

// KMS client is a module-level singleton — createKMSClient() returns
// KMSMock in test/emulator environments (NODE_ENV=test or FUNCTIONS_EMULATOR=true).
const kms = createKMSClient();

export const onEvidenceCreate = functions.firestore
  .document("evidence/{evidenceId}")
  .onCreate(async (snapshot, context) => {
    const evidenceId = context.params["evidenceId"] as string;
    const db = getFirestore();
    const bucket = getStorage().bucket();

    await runEvidenceCreatePipeline(
      evidenceId,
      db,
      bucket,
      kms,
      functions.logger
    );
  });
