/**
 * Tests for access control Cloud Functions (Phase 8).
 * Requirements: 5.6, 7.4, 7.5, 8.3, 8.5, 8.6
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runSetLegalHold, runReleaseLegalHold,
  runGrantEvidenceAccess, runRevokeEvidenceAccess,
  runRecordEvidenceViewed,
} from "./accessControl.js";
import type { ChainOfCustodyEntry } from "../types/evidence.js";

afterEach(() => { delete process.env["EVIDENCE_RETENTION_DAYS"]; });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDocSnap(status = "available", extra: Record<string, unknown> = {}) {
  return {
    exists: true,
    data: () => ({
      evidenceId: "ev-001", incidentId: "inc-001", userId: "user-001",
      type: "photo", storageRef: "evidence/ev-001/photo.jpg",
      originalFilename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 1024,
      sha256Hash: "a".repeat(64), encryptionKeyRef: "kref", encryptionIV: "aWlu",
      status, retentionExpiresAt: null, legalHoldReason: null, chainOfCustody: [],
      createdAt: new Date("2024-01-01"), updatedAt: new Date("2024-01-01"),
      metadata: { capturedAt: new Date("2024-01-01"), deviceInfo: "test", locationHash: null, incidentContext: null },
      ...extra,
    }),
  };
}

function makeDb(
  docSnap: { exists: boolean; data: () => Record<string, unknown> },
  contactSnap?: { exists: boolean; data: () => Record<string, unknown> }
) {
  const updates: Record<string, unknown>[] = [];
  const sets: Record<string, unknown>[] = [];

  const db = {
    collection: vi.fn().mockImplementation((col: string) => {
      if (col === "grantedContacts") {
        return {
          doc: vi.fn().mockReturnValue({
            collection: vi.fn().mockReturnValue({
              doc: vi.fn().mockReturnValue({
                get: vi.fn().mockResolvedValue(
                  contactSnap ?? { exists: false, data: () => ({}) }
                ),
              }),
            }),
          }),
        };
      }
      return {
        doc: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue(docSnap),
        }),
      };
    }),
    runTransaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: vi.fn().mockResolvedValue(docSnap),
        update: vi.fn((_: unknown, data: Record<string, unknown>) => updates.push(data)),
        set: vi.fn((_: unknown, data: Record<string, unknown>) => sets.push(data)),
      };
      await fn(tx);
    }),
  } as unknown as import("firebase-admin/firestore").Firestore;

  return { db, updates, sets };
}

// ---------------------------------------------------------------------------
// setLegalHold
// ---------------------------------------------------------------------------
describe("setLegalHold (Req 8.3, 8.5)", () => {
  it("throws INVALID_ARGUMENT for empty legalHoldReason", async () => {
    const { db } = makeDb(makeDocSnap("available"));
    const err = await runSetLegalHold("ev-001", "user-001", "", db).catch(e => e);
    expect(err.code).toBe("INVALID_ARGUMENT");
  });

  it("throws INVALID_ARGUMENT for legalHoldReason > 1000 chars", async () => {
    const { db } = makeDb(makeDocSnap("available"));
    const err = await runSetLegalHold("ev-001", "user-001", "x".repeat(1001), db).catch(e => e);
    expect(err.code).toBe("INVALID_ARGUMENT");
  });

  it("throws PRECONDITION_FAILED if already in legal_hold", async () => {
    const { db } = makeDb(makeDocSnap("legal_hold"));
    const err = await runSetLegalHold("ev-001", "user-001", "reason", db).catch(e => e);
    expect(err.code).toBe("PRECONDITION_FAILED");
  });

  it("sets status to legal_hold with a legal_hold_set custody entry", async () => {
    process.env["EVIDENCE_RETENTION_DAYS"] = "90";
    const { db, updates } = makeDb(makeDocSnap("available"));
    await runSetLegalHold("ev-001", "user-001", "ongoing investigation", db);
    expect(updates[0]!["status"]).toBe("legal_hold");
    expect(updates[0]!["legalHoldReason"]).toBe("ongoing investigation");
    const custody = updates[0]!["chainOfCustody"] as ChainOfCustodyEntry[];
    expect(custody[0]!.action).toBe("legal_hold_set");
    expect(custody[0]!.timestamp).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// releaseLegalHold
// ---------------------------------------------------------------------------
describe("releaseLegalHold (Req 8.6)", () => {
  it("throws PRECONDITION_FAILED if not in legal_hold", async () => {
    const { db } = makeDb(makeDocSnap("available"));
    const err = await runReleaseLegalHold("ev-001", "user-001", db).catch(e => e);
    expect(err.code).toBe("PRECONDITION_FAILED");
  });

  it("sets status back to available with a recalculated retentionExpiresAt and legal_hold_released entry", async () => {
    process.env["EVIDENCE_RETENTION_DAYS"] = "90";
    const { db, updates } = makeDb(makeDocSnap("legal_hold"));
    await runReleaseLegalHold("ev-001", "user-001", db);
    expect(updates[0]!["status"]).toBe("available");
    expect(updates[0]!["legalHoldReason"]).toBeNull();
    expect(updates[0]!["retentionExpiresAt"]).toBeInstanceOf(Date);
    // retentionExpiresAt should be approx now + 90 days
    const expected = Date.now() + 90 * 86_400_000;
    const actual = (updates[0]!["retentionExpiresAt"] as Date).getTime();
    expect(Math.abs(actual - expected)).toBeLessThan(5000); // within 5s
    const custody = updates[0]!["chainOfCustody"] as ChainOfCustodyEntry[];
    expect(custody[0]!.action).toBe("legal_hold_released");
    expect(custody[0]!.timestamp).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// grantEvidenceAccess
// ---------------------------------------------------------------------------
describe("grantEvidenceAccess (Req 7.4)", () => {
  it("throws INVALID_ARGUMENT for empty contactUid", async () => {
    const { db } = makeDb(makeDocSnap("available"));
    const err = await runGrantEvidenceAccess("ev-001", "user-001", "", db).catch(e => e);
    expect(err.code).toBe("INVALID_ARGUMENT");
  });

  it("creates GrantedContact document and appends 'granted' custody entry", async () => {
    const { db, updates, sets } = makeDb(makeDocSnap("available"));
    await runGrantEvidenceAccess("ev-001", "user-001", "contact-uid", db);
    // GrantedContact was set
    expect(sets[0]!["contactUid"]).toBe("contact-uid");
    expect(sets[0]!["revoked"]).toBe(false);
    expect(sets[0]!["grantedAt"]).toBeInstanceOf(Date);
    // Custody entry appended
    const custody = updates[0]!["chainOfCustody"] as ChainOfCustodyEntry[];
    expect(custody[0]!.action).toBe("granted");
    expect(custody[0]!.metadata?.["contactUid"]).toBe("contact-uid");
    expect(custody[0]!.timestamp).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// revokeEvidenceAccess
// ---------------------------------------------------------------------------
describe("revokeEvidenceAccess (Req 7.5)", () => {
  it("throws PRECONDITION_FAILED when contact has no active grant", async () => {
    const { db } = makeDb(makeDocSnap("available"), { exists: false, data: () => ({}) });
    const err = await runRevokeEvidenceAccess("ev-001", "user-001", "no-grant-uid", db).catch(e => e);
    expect(err.code).toBe("PRECONDITION_FAILED");
  });

  it("throws PRECONDITION_FAILED when contact's grant is already revoked", async () => {
    const { db } = makeDb(makeDocSnap("available"), { exists: true, data: () => ({ revoked: true }) });
    const err = await runRevokeEvidenceAccess("ev-001", "user-001", "contact-uid", db).catch(e => e);
    expect(err.code).toBe("PRECONDITION_FAILED");
  });

  it("revokes contact and appends 'revoked' custody entry", async () => {
    const { db, updates } = makeDb(
      makeDocSnap("available"),
      { exists: true, data: () => ({ revoked: false }) }
    );
    await runRevokeEvidenceAccess("ev-001", "user-001", "contact-uid", db);
    // First update is the GrantedContact revocation, second is the evidence doc
    const evidenceUpdate = updates.find(u => Array.isArray(u["chainOfCustody"]));
    const custody = evidenceUpdate!["chainOfCustody"] as ChainOfCustodyEntry[];
    expect(custody[0]!.action).toBe("revoked");
    expect(custody[0]!.metadata?.["contactUid"]).toBe("contact-uid");
    expect(custody[0]!.timestamp).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// recordEvidenceViewed
// ---------------------------------------------------------------------------
describe("recordEvidenceViewed (Req 5.6)", () => {
  it("throws UNAUTHENTICATED for empty callerUid", async () => {
    const { db } = makeDb(makeDocSnap("available"));
    const err = await runRecordEvidenceViewed("ev-001", "", db).catch(e => e);
    expect(err.code).toBe("UNAUTHENTICATED");
  });

  it("throws PERMISSION_DENIED for unauthorised caller", async () => {
    const { db } = makeDb(
      makeDocSnap("available"),
      { exists: false, data: () => ({}) }
    );
    const err = await runRecordEvidenceViewed("ev-001", "hacker", db).catch(e => e);
    expect(err.code).toBe("PERMISSION_DENIED");
  });

  it("appends a 'viewed' entry with native Date timestamp for the owner", async () => {
    const { db, updates } = makeDb(makeDocSnap("available"));
    await runRecordEvidenceViewed("ev-001", "user-001", db);
    const custody = updates[0]!["chainOfCustody"] as ChainOfCustodyEntry[];
    expect(custody[0]!.action).toBe("viewed");
    expect(custody[0]!.performedBy).toBe("user-001");
    expect(custody[0]!.timestamp).toBeInstanceOf(Date);
  });
});
