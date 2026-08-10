/**
 * onEvidenceCreate — Firestore onCreate trigger.
 *
 * Fires when a new document is created in /evidence/{evidenceId}.
 * Delegates all logic to runEvidenceCreatePipeline().
 *
 * kms and bucket are injected from index.ts so that the same KMSMock
 * singleton is shared across onEvidenceCreate, serveEvidenceFile, and
 * generateLegalExport. In the emulator, KMSMock stores DEKs in-memory —
 * if each function creates its own instance, decryption in a later function
 * call will always fail with "unknown encryptedDEK".
 *
 * Requirements: 3, 4, 5, 8, 10, 11
 * Design: §onEvidenceCreate Cloud Function Pipeline
 */
import * as functions from "firebase-functions";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage, type Storage } from "firebase-admin/storage";
import { initializeApp, getApps } from "firebase-admin/app";
import type { KMSClient } from "../../kms/kms.interface.js";
import { runEvidenceCreatePipeline } from "./pipeline.js";

// Ensure Firebase Admin is initialized exactly once.
if (getApps().length === 0) {
  initializeApp();
}

type Bucket = ReturnType<ReturnType<typeof getStorage>["bucket"]>;

/**
 * Factory — call once from index.ts, passing the shared kms singleton
 * and the correct bucket instance so the KMSMock store is shared.
 */
export function createOnEvidenceCreate(kms: KMSClient, bucket: Bucket) {
  return functions.firestore
    .document("evidence/{evidenceId}")
    .onCreate(async (snapshot, context) => {
      const evidenceId = context.params["evidenceId"] as string;
      const db = getFirestore();

      await runEvidenceCreatePipeline(
        evidenceId,
        db,
        bucket,
        kms,
        functions.logger
      );
    });
}
