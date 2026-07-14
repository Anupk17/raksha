/**
 * serveEvidenceFile — HTTPS callable Cloud Function.
 *
 * Mediates all access to evidence files. The Storage bucket denies all client
 * reads directly (security rules: allow read: if false), so every file read
 * goes through this function.
 *
 * Steps (design.md §serveEvidenceFile Function Design):
 *   1. Verify Firebase Auth token (401 if absent).
 *   2. Fetch evidence document from Firestore (404 if missing).
 *   3. Authorisation: caller uid must match evidence.userId (owner) OR be an
 *      active (non-revoked) GrantedContact.
 *   4. Fetch encrypted bytes from Storage.
 *   5. Decrypt DEK via KMS.
 *   6. Decrypt file bytes with AES-256-GCM; throw on auth-tag failure.
 *   7. Append 'viewed' custody entry (within 5 s of function invocation).
 *   8. Return decrypted bytes with original mimeType.
 *
 * Requirements: 5.6, 6.6, 7.1, 7.2, 7.3
 */
import type { Firestore } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import type { KMSClient } from "../kms/kms.interface.js";
import { aesGcmDecrypt } from "../utils/aesGcm.js";
import { appendCustodyEntry } from "../utils/appendCustodyEntry.js";
import { computeIntegritySnapshot } from "../utils/integritySnapshot.js";
import { deserializeFirestoreDate } from "../utils/assertDate.js";
import type { ChainOfCustodyEntry, EvidenceDocument } from "../types/evidence.js";
import type { PipelineLogger } from "./onEvidenceCreate/pipeline.js";

export interface ServeEvidenceFileRequest {
  evidenceId: string;
}

export interface ServeEvidenceFileResult {
  /** Base64-encoded decrypted file bytes. */
  data: string;
  mimeType: string;
}

export async function runServeEvidenceFile(
  evidenceId: string,
  callerUid: string,
  db: Firestore,
  bucket: ReturnType<Storage["bucket"]>,
  kms: KMSClient,
  logger: PipelineLogger,
  keyRingRef: string
): Promise<ServeEvidenceFileResult> {
  const invocationTime = new Date();

  // Step 1 — Auth
  if (!callerUid) {
    throw Object.assign(new Error("serveEvidenceFile: unauthenticated"), { code: "UNAUTHENTICATED" });
  }

  // Step 2 — Fetch document
  const ref = db.collection("evidence").doc(evidenceId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw Object.assign(new Error(`serveEvidenceFile: '${evidenceId}' not found`), { code: "NOT_FOUND" });
  }
  const doc = snap.data() as Record<string, unknown>;

  // Step 3 — Authorisation: owner OR active GrantedContact
  const isOwner = doc["userId"] === callerUid;
  let isGranted = false;
  if (!isOwner) {
    const ownerId = doc["userId"] as string;
    const contactRef = db
      .collection("grantedContacts")
      .doc(ownerId)
      .collection("contacts")
      .doc(callerUid);
    const contactSnap = await contactRef.get();
    isGranted = contactSnap.exists && contactSnap.data()?.["revoked"] !== true;
  }
  if (!isOwner && !isGranted) {
    throw Object.assign(
      new Error(`serveEvidenceFile: caller '${callerUid}' is not authorised to access '${evidenceId}'`),
      { code: "PERMISSION_DENIED" }
    );
  }

  // Step 4 — Fetch encrypted bytes
  const storageRef = doc["storageRef"] as string;
  let encryptedBytes: Buffer;
  try {
    const [contents] = await bucket.file(storageRef).download();
    encryptedBytes = contents;
  } catch (e) {
    throw Object.assign(
      new Error(`serveEvidenceFile: Storage file inaccessible for '${evidenceId}': ${(e as Error).message}`),
      { code: "UNAVAILABLE" }
    );
  }

  // Step 5 — Decrypt DEK via KMS
  const encryptionKeyRef = doc["encryptionKeyRef"] as string;
  let plaintextDEK: Buffer;
  try {
    plaintextDEK = await kms.decryptDataEncryptionKey(encryptionKeyRef, keyRingRef);
  } catch (e) {
    throw Object.assign(
      new Error(`serveEvidenceFile: KMS decryption failed for '${evidenceId}': ${(e as Error).message}`),
      { code: "INTERNAL" }
    );
  }

  // Step 6 — Decrypt file bytes
  const iv = Buffer.from(doc["encryptionIV"] as string, "base64");
  let plaintext: Buffer;
  try {
    plaintext = aesGcmDecrypt(encryptedBytes, plaintextDEK, iv);
  } catch (e) {
    throw Object.assign(
      new Error(`serveEvidenceFile: AES-GCM decryption failed for '${evidenceId}' — possible tampering`),
      { code: "DATA_LOSS" }
    );
  }

  // Step 7 — Append 'viewed' custody entry within 5 seconds of invocation
  let integritySnapshot: string | null = null;
  try {
    const docData = { ...doc };
    docData["createdAt"] = deserializeFirestoreDate(docData["createdAt"], "createdAt");
    integritySnapshot = computeIntegritySnapshot(docData as unknown as EvidenceDocument);
  } catch { /* non-fatal */ }

  const entry: ChainOfCustodyEntry = {
    action: "viewed",
    performedBy: callerUid,
    timestamp: new Date(),
    evidenceId,
    metadata: { accessorRole: isOwner ? "owner" : "granted_contact" },
    integritySnapshot,
  };

  // Verify we're still within the 5-second window (Req 5.6)
  const elapsedMs = Date.now() - invocationTime.getTime();
  if (elapsedMs > 5_000) {
    logger.warn(`[serveEvidenceFile] viewed entry elapsed ${elapsedMs}ms > 5000ms for ${evidenceId}`);
  }

  try {
    await db.runTransaction(async (tx) => {
      await appendCustodyEntry(tx, ref, entry);
    });
  } catch (e) {
    // Per Req 5.5: custody append failure must prevent file delivery
    throw Object.assign(
      new Error(`serveEvidenceFile: custody append failed for '${evidenceId}': ${(e as Error).message}`),
      { code: "INTERNAL" }
    );
  }

  // Step 8 — Return decrypted bytes
  return {
    data: plaintext.toString("base64"),
    mimeType: doc["mimeType"] as string,
  };
}

export function createServeEvidenceFileHandler(
  db: Firestore,
  bucket: ReturnType<Storage["bucket"]>,
  kms: KMSClient,
  logger: PipelineLogger,
  keyRingRef: string
) {
  return async (
    data: ServeEvidenceFileRequest,
    context: { auth?: { uid: string } }
  ): Promise<ServeEvidenceFileResult> => {
    return runServeEvidenceFile(
      data.evidenceId,
      context.auth?.uid ?? "",
      db, bucket, kms, logger, keyRingRef
    );
  };
}
