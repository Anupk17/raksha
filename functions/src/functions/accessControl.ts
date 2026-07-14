/**
 * Access control Cloud Functions:
 *   setLegalHold, releaseLegalHold,
 *   grantEvidenceAccess, revokeEvidenceAccess,
 *   recordEvidenceViewed
 *
 * All follow the same guard pattern:
 *   1. Auth check (UNAUTHENTICATED)
 *   2. Document fetch (NOT_FOUND)
 *   3. Ownership check (PERMISSION_DENIED)
 *   4. State/validation check (PRECONDITION_FAILED / INVALID_ARGUMENT)
 *   5. Firestore conditional transaction + custody entry
 *
 * Requirements: 5.6, 7.4, 7.5, 8.3, 8.5, 8.6
 */
import type { Firestore } from "firebase-admin/firestore";
import { appendCustodyEntry } from "../utils/appendCustodyEntry.js";
import { computeIntegritySnapshot } from "../utils/integritySnapshot.js";
import { computeRetentionExpiresAt, getRetentionPeriodDays } from "../utils/retentionConfig.js";
import { deserializeFirestoreDate } from "../utils/assertDate.js";
import type { ChainOfCustodyEntry, EvidenceDocument, GrantedContact } from "../types/evidence.js";

// ---------------------------------------------------------------------------
// Shared guard helper
// ---------------------------------------------------------------------------

async function guardOwner(
  evidenceId: string,
  callerUid: string,
  db: Firestore
): Promise<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> {
  if (!callerUid) {
    throw Object.assign(new Error("caller is not authenticated"), { code: "UNAUTHENTICATED" });
  }
  const ref = db.collection("evidence").doc(evidenceId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw Object.assign(new Error(`evidence document '${evidenceId}' not found`), { code: "NOT_FOUND" });
  }
  const data = snap.data() as Record<string, unknown>;
  if (data["userId"] !== callerUid) {
    throw Object.assign(
      new Error(`caller '${callerUid}' is not the owner of '${evidenceId}'`),
      { code: "PERMISSION_DENIED" }
    );
  }
  return { ref, data };
}

function safeSnapshot(data: Record<string, unknown>): string | null {
  try {
    const docData = { ...data };
    docData["createdAt"] = deserializeFirestoreDate(docData["createdAt"], "createdAt");
    return computeIntegritySnapshot(docData as unknown as EvidenceDocument);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// setLegalHold
// ---------------------------------------------------------------------------

export async function runSetLegalHold(
  evidenceId: string,
  callerUid: string,
  legalHoldReason: string,
  db: Firestore
): Promise<void> {
  const { ref, data } = await guardOwner(evidenceId, callerUid, db);

  if (!legalHoldReason || legalHoldReason.length === 0) {
    throw Object.assign(new Error("legalHoldReason must be a non-empty string"), { code: "INVALID_ARGUMENT" });
  }
  if (legalHoldReason.length > 1000) {
    throw Object.assign(new Error("legalHoldReason must not exceed 1000 characters"), { code: "INVALID_ARGUMENT" });
  }
  if (data["status"] === "legal_hold") {
    throw Object.assign(new Error(`'${evidenceId}' is already in legal_hold`), { code: "PRECONDITION_FAILED" });
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data() as Record<string, unknown>;
    const custody = (current["chainOfCustody"] ?? []) as ChainOfCustodyEntry[];
    const entry: ChainOfCustodyEntry = {
      action: "legal_hold_set",
      performedBy: callerUid,
      timestamp: new Date(),
      evidenceId,
      metadata: { reason: legalHoldReason.slice(0, 256) },
      integritySnapshot: safeSnapshot(current),
    };
    tx.update(ref, {
      status: "legal_hold",
      legalHoldReason,
      chainOfCustody: [...custody, entry],
      updatedAt: new Date(),
    });
  });
}

// ---------------------------------------------------------------------------
// releaseLegalHold
// ---------------------------------------------------------------------------

export async function runReleaseLegalHold(
  evidenceId: string,
  callerUid: string,
  db: Firestore
): Promise<void> {
  const { ref, data } = await guardOwner(evidenceId, callerUid, db);

  if (data["status"] !== "legal_hold") {
    throw Object.assign(
      new Error(`'${evidenceId}' is not in legal_hold (current: ${data["status"]})`),
      { code: "PRECONDITION_FAILED" }
    );
  }

  const retentionDays = getRetentionPeriodDays();
  const newRetentionExpiresAt = computeRetentionExpiresAt(new Date(), retentionDays);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data() as Record<string, unknown>;
    const custody = (current["chainOfCustody"] ?? []) as ChainOfCustodyEntry[];
    const entry: ChainOfCustodyEntry = {
      action: "legal_hold_released",
      performedBy: callerUid,
      timestamp: new Date(),
      evidenceId,
      metadata: null,
      integritySnapshot: safeSnapshot(current),
    };
    tx.update(ref, {
      status: "available",
      legalHoldReason: null,
      retentionExpiresAt: newRetentionExpiresAt,
      chainOfCustody: [...custody, entry],
      updatedAt: new Date(),
    });
  });
}

// ---------------------------------------------------------------------------
// grantEvidenceAccess
// ---------------------------------------------------------------------------

export async function runGrantEvidenceAccess(
  evidenceId: string,
  callerUid: string,
  contactUid: string,
  db: Firestore
): Promise<void> {
  const { ref, data } = await guardOwner(evidenceId, callerUid, db);

  if (!contactUid) {
    throw Object.assign(new Error("contactUid must be non-empty"), { code: "INVALID_ARGUMENT" });
  }

  const ownerId = data["userId"] as string;
  const contactRef = db
    .collection("grantedContacts")
    .doc(ownerId)
    .collection("contacts")
    .doc(contactUid);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data() as Record<string, unknown>;
    const custody = (current["chainOfCustody"] ?? []) as ChainOfCustodyEntry[];

    const grantedContact: GrantedContact = {
      contactUid,
      ownerId,
      grantedAt: new Date(),
      revoked: false,
      revokedAt: null,
    };
    tx.set(contactRef, grantedContact);

    const entry: ChainOfCustodyEntry = {
      action: "granted",
      performedBy: callerUid,
      timestamp: new Date(),
      evidenceId,
      metadata: { ownerUid: callerUid, contactUid },
      integritySnapshot: safeSnapshot(current),
    };
    tx.update(ref, {
      chainOfCustody: [...custody, entry],
      updatedAt: new Date(),
    });
  });
}

// ---------------------------------------------------------------------------
// revokeEvidenceAccess
// ---------------------------------------------------------------------------

export async function runRevokeEvidenceAccess(
  evidenceId: string,
  callerUid: string,
  contactUid: string,
  db: Firestore
): Promise<void> {
  const { ref, data } = await guardOwner(evidenceId, callerUid, db);

  const ownerId = data["userId"] as string;
  const contactRef = db
    .collection("grantedContacts")
    .doc(ownerId)
    .collection("contacts")
    .doc(contactUid);

  const contactSnap = await contactRef.get();
  if (!contactSnap.exists || contactSnap.data()?.["revoked"] === true) {
    throw Object.assign(
      new Error(`contact '${contactUid}' does not hold an active grant on '${evidenceId}'`),
      { code: "PRECONDITION_FAILED" }
    );
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.data() as Record<string, unknown>;
    const custody = (current["chainOfCustody"] ?? []) as ChainOfCustodyEntry[];

    tx.update(contactRef, { revoked: true, revokedAt: new Date() });

    const entry: ChainOfCustodyEntry = {
      action: "revoked",
      performedBy: callerUid,
      timestamp: new Date(),
      evidenceId,
      metadata: { ownerUid: callerUid, contactUid },
      integritySnapshot: safeSnapshot(current),
    };
    tx.update(ref, {
      chainOfCustody: [...custody, entry],
      updatedAt: new Date(),
    });
  });
}

// ---------------------------------------------------------------------------
// recordEvidenceViewed
// ---------------------------------------------------------------------------

export async function runRecordEvidenceViewed(
  evidenceId: string,
  callerUid: string,
  db: Firestore
): Promise<void> {
  if (!callerUid) {
    throw Object.assign(new Error("caller is not authenticated"), { code: "UNAUTHENTICATED" });
  }
  const ref = db.collection("evidence").doc(evidenceId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw Object.assign(new Error(`evidence document '${evidenceId}' not found`), { code: "NOT_FOUND" });
  }

  const data = snap.data() as Record<string, unknown>;
  const isOwner = data["userId"] === callerUid;
  if (!isOwner) {
    const ownerId = data["userId"] as string;
    const contactSnap = await db
      .collection("grantedContacts")
      .doc(ownerId)
      .collection("contacts")
      .doc(callerUid)
      .get();
    if (!contactSnap.exists || contactSnap.data()?.["revoked"] === true) {
      throw Object.assign(
        new Error(`caller '${callerUid}' is not authorised to view '${evidenceId}'`),
        { code: "PERMISSION_DENIED" }
      );
    }
  }

  await db.runTransaction(async (tx) => {
    const entry: ChainOfCustodyEntry = {
      action: "viewed",
      performedBy: callerUid,
      timestamp: new Date(),
      evidenceId,
      metadata: null,
      integritySnapshot: null,
    };
    await appendCustodyEntry(tx, ref, entry);
  });
}
