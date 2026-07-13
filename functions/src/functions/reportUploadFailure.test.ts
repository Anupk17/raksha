/**
 * Tests for reportUploadFailure Cloud Function (Phase 3).
 *
 * Uses the same lightweight in-memory Firestore mock pattern as pipeline.test.ts.
 * No Firebase Emulator needed — real transaction serialization is tested in Phase 13.
 *
 * Requirements: 1.8, 5.1, 5.4, 6.2
 * Design: §reportUploadFailure Function Design
 */
import { describe, it, expect, vi } from "vitest";
import { runReportUploadFailure } from "./reportUploadFailure.js";
import type { ChainOfCustodyEntry } from "../types/evidence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDocData(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    evidenceId: "ev-001",
    incidentId: "inc-001",
    userId: "user-001",
    type: "photo",
    storageRef: "evidence/ev-001/photo.jpg",
    originalFilename: "photo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    sha256Hash: "a".repeat(64),
    encryptionKeyRef: "",
    encryptionIV: "",
    status: "uploading",
    retentionExpiresAt: null,
    legalHoldReason: null,
    chainOfCustody: [],
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    metadata: {
      capturedAt: new Date("2024-01-01T00:00:00.000Z"),
      deviceInfo: "test",
      locationHash: null,
      incidentContext: null,
    },
    ...overrides,
  };
}

function makeDb(
  snapData: Record<string, unknown> | null,
  opts: { transactionSnapData?: Record<string, unknown> | null } = {}
) {
  const updates: Record<string, unknown>[] = [];
  // The transaction snap can differ from the initial read (simulates a race)
  const txSnapData = opts.transactionSnapData !== undefined
    ? opts.transactionSnapData
    : snapData;

  const db = {
    collection: vi.fn().mockReturnValue({
      doc: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue({
          exists: snapData !== null,
          data: () => (snapData !== null ? { ...snapData } : undefined),
        }),
      }),
    }),
    runTransaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: vi.fn().mockResolvedValue({
          exists: txSnapData !== null,
          data: () => (txSnapData !== null ? { ...txSnapData } : undefined),
        }),
        update: vi.fn((_ref: unknown, data: Record<string, unknown>) => updates.push(data)),
      };
      await fn(tx);
    }),
  } as unknown as import("firebase-admin/firestore").Firestore;

  return { db, updates };
}

// ---------------------------------------------------------------------------
// Auth / ownership guard tests
// ---------------------------------------------------------------------------

describe("reportUploadFailure — auth and ownership", () => {
  it("throws UNAUTHENTICATED when callerUid is empty", async () => {
    const { db } = makeDb(makeDocData());
    const err = await runReportUploadFailure("ev-001", "", db).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("UNAUTHENTICATED");
  });

  it("throws NOT_FOUND when document does not exist", async () => {
    const { db } = makeDb(null);
    const err = await runReportUploadFailure("ev-001", "user-001", db).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("NOT_FOUND");
  });

  it("throws PERMISSION_DENIED when caller is not the owner", async () => {
    const { db } = makeDb(makeDocData({ userId: "owner-999" }));
    const err = await runReportUploadFailure("ev-001", "different-user", db).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("PERMISSION_DENIED");
  });
});

// ---------------------------------------------------------------------------
// Happy path: status 'uploading' → commits 'failed'
// ---------------------------------------------------------------------------

describe("reportUploadFailure — status 'uploading' path", () => {
  it("returns outcome FAILED and writes status:failed with a status_changed custody entry", async () => {
    const { db, updates } = makeDb(makeDocData({ status: "uploading", chainOfCustody: [] }));

    const result = await runReportUploadFailure("ev-001", "user-001", db);

    expect(result.outcome).toBe("FAILED");
    expect(updates).toHaveLength(1);
    expect(updates[0]!["status"]).toBe("failed");

    const custody = updates[0]!["chainOfCustody"] as ChainOfCustodyEntry[];
    expect(custody).toHaveLength(1);
    const entry = custody[0]!;
    expect(entry.action).toBe("status_changed");
    expect(entry.performedBy).toBe("cloud_function");
    // CRITICAL: timestamp must be native Date (Req 10.1)
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(entry.evidenceId).toBe("ev-001");
    expect(entry.metadata?.["reason"]).toBe("client_storage_failure");
    expect(entry.metadata?.["priorStatus"]).toBe("uploading");
    expect(entry.metadata?.["newStatus"]).toBe("failed");
  });

  it("appends to an existing chainOfCustody, not replaces it", async () => {
    const existing: ChainOfCustodyEntry[] = [{
      action: "status_changed",
      performedBy: "cloud_function",
      timestamp: new Date(),
      evidenceId: "ev-001",
      metadata: null,
      integritySnapshot: null,
    }];
    const { db, updates } = makeDb(makeDocData({ status: "uploading", chainOfCustody: existing }));

    await runReportUploadFailure("ev-001", "user-001", db);

    const custody = updates[0]!["chainOfCustody"] as ChainOfCustodyEntry[];
    expect(custody).toHaveLength(2);
    expect(custody[0]).toEqual(existing[0]);
    expect(custody[1]!.action).toBe("status_changed");
  });

  it("sets updatedAt to a new native Date (Req 10.1)", async () => {
    const oldUpdatedAt = new Date("2020-01-01");
    const { db, updates } = makeDb(makeDocData({ status: "uploading", updatedAt: oldUpdatedAt }));

    await runReportUploadFailure("ev-001", "user-001", db);

    expect(updates[0]!["updatedAt"]).toBeInstanceOf(Date);
    expect((updates[0]!["updatedAt"] as Date).getTime()).toBeGreaterThan(oldUpdatedAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// ALREADY_PROCESSING path: pipeline already in-flight
// ---------------------------------------------------------------------------

describe("reportUploadFailure — ALREADY_PROCESSING path (P18: race safety)", () => {
  it("returns ALREADY_PROCESSING and makes no Firestore writes when status is 'processing'", async () => {
    // Simulates: onEvidenceCreate Step 1 already committed; client races in late
    const { db, updates } = makeDb(
      makeDocData({ status: "uploading" }),          // outer get returns uploading
      { transactionSnapData: makeDocData({ status: "processing" }) }  // tx read sees processing
    );

    const result = await runReportUploadFailure("ev-001", "user-001", db);

    expect(result.outcome).toBe("ALREADY_PROCESSING");
    expect(updates).toHaveLength(0); // no Firestore writes
  });

  it("returns ALREADY_PROCESSING when status is 'available'", async () => {
    const { db, updates } = makeDb(
      makeDocData({ status: "uploading" }),
      { transactionSnapData: makeDocData({ status: "available" }) }
    );

    const result = await runReportUploadFailure("ev-001", "user-001", db);

    expect(result.outcome).toBe("ALREADY_PROCESSING");
    expect(updates).toHaveLength(0);
  });

  it("returns ALREADY_PROCESSING when status is already 'failed' (idempotent)", async () => {
    const { db, updates } = makeDb(
      makeDocData({ status: "uploading" }),
      { transactionSnapData: makeDocData({ status: "failed" }) }
    );

    const result = await runReportUploadFailure("ev-001", "user-001", db);

    expect(result.outcome).toBe("ALREADY_PROCESSING");
    expect(updates).toHaveLength(0);
  });
});
