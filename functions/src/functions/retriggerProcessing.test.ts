/**
 * Tests for retriggerProcessing Cloud Function (Phase 4).
 *
 * Requirements: 2.3, 2.7, 11.5
 * Design: §Race Condition Resolution — retriggerProcessing Function Design
 */
import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";
import { runRetriggerProcessing } from "./retriggerProcessing.js";
import { KMSMock } from "../kms/KMSMock.js";
import type { PipelineLogger } from "./onEvidenceCreate/pipeline.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): PipelineLogger & { messages: { level: string; text: string }[] } {
  const messages: { level: string; text: string }[] = [];
  return {
    messages,
    info:  (t) => messages.push({ level: "info",  text: t }),
    warn:  (t) => messages.push({ level: "warn",  text: t }),
    error: (t) => messages.push({ level: "error", text: t }),
  };
}

function recentDate(offsetMs = 0): Date {
  return new Date(Date.now() - offsetMs);
}

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
    updatedAt: recentDate(5_000), // 5 seconds ago — well within 30s window
    metadata: {
      capturedAt: new Date("2024-01-01T00:00:00.000Z"),
      deviceInfo: "test",
      locationHash: null,
      incidentContext: null,
    },
    ...overrides,
  };
}

function makeDb(snapData: Record<string, unknown> | null) {
  const updates: Record<string, unknown>[] = [];
  const snapHistory = snapData ? [{ ...snapData }] : null;
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
      const head = snapHistory ? snapHistory[snapHistory.length - 1]! : null;
      const tx = {
        get: vi.fn().mockResolvedValue({
          exists: head !== null,
          data: () => (head !== null ? { ...head } : undefined),
        }),
        update: vi.fn((_: unknown, data: Record<string, unknown>) => {
          updates.push(data);
          if (snapHistory && head) snapHistory.push({ ...head, ...data });
        }),
      };
      await fn(tx);
    }),
  } as unknown as import("firebase-admin/firestore").Firestore;
  return { db, updates };
}

function makeBucket(opts: { fileExists?: boolean; downloadContent?: Buffer } = {}) {
  const rawBytes = opts.downloadContent ?? Buffer.from("test file content");
  const sha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
  const encryptedBytes: Buffer[] = [];
  const file = {
    exists: vi.fn().mockResolvedValue([opts.fileExists ?? true]),
    download: vi.fn().mockResolvedValue([rawBytes]),
    save: vi.fn().mockImplementation(async (data: Buffer) => encryptedBytes.push(data)),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const bucket = {
    file: vi.fn().mockReturnValue(file),
  } as unknown as ReturnType<import("firebase-admin/storage").Storage["bucket"]>;
  return { bucket, file, sha256, rawBytes, encryptedBytes };
}

// ---------------------------------------------------------------------------
// Auth / ownership / precondition guard tests
// ---------------------------------------------------------------------------

describe("retriggerProcessing — auth and ownership", () => {
  it("throws UNAUTHENTICATED when callerUid is empty", async () => {
    const { db } = makeDb(makeDocData());
    const { bucket } = makeBucket();
    const err = await runRetriggerProcessing("ev-001", "", db, bucket, new KMSMock(), makeLogger()).catch(e => e);
    expect((err as NodeJS.ErrnoException).code).toBe("UNAUTHENTICATED");
  });

  it("throws NOT_FOUND when document does not exist", async () => {
    const { db } = makeDb(null);
    const { bucket } = makeBucket();
    const err = await runRetriggerProcessing("ev-001", "user-001", db, bucket, new KMSMock(), makeLogger()).catch(e => e);
    expect((err as NodeJS.ErrnoException).code).toBe("NOT_FOUND");
  });

  it("throws PERMISSION_DENIED when caller is not the owner", async () => {
    const { db } = makeDb(makeDocData({ userId: "owner-999" }));
    const { bucket } = makeBucket();
    const err = await runRetriggerProcessing("ev-001", "attacker", db, bucket, new KMSMock(), makeLogger()).catch(e => e);
    expect((err as NodeJS.ErrnoException).code).toBe("PERMISSION_DENIED");
  });
});

describe("retriggerProcessing — precondition checks", () => {
  it("throws PRECONDITION_FAILED when status is not 'uploading'", async () => {
    const { db } = makeDb(makeDocData({ status: "processing" }));
    const { bucket } = makeBucket();
    const err = await runRetriggerProcessing("ev-001", "user-001", db, bucket, new KMSMock(), makeLogger()).catch(e => e);
    expect((err as NodeJS.ErrnoException).code).toBe("PRECONDITION_FAILED");
    expect(err.message).toContain("processing");
  });

  it("throws PRECONDITION_FAILED when updatedAt is older than 30s (claim window expired)", async () => {
    const { db } = makeDb(makeDocData({
      status: "uploading",
      updatedAt: recentDate(35_000), // 35 seconds ago — outside window
    }));
    const { bucket } = makeBucket();
    const err = await runRetriggerProcessing("ev-001", "user-001", db, bucket, new KMSMock(), makeLogger()).catch(e => e);
    expect((err as NodeJS.ErrnoException).code).toBe("PRECONDITION_FAILED");
    expect(err.message).toContain("claim window");
  });

  it("accepts updatedAt just within the 30s window", async () => {
    const rawBytes = Buffer.from("file content");
    const sha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
    const { db } = makeDb(makeDocData({
      status: "uploading",
      updatedAt: recentDate(25_000), // 25s ago — inside window
      sha256Hash: sha256,
    }));
    const { bucket } = makeBucket({ fileExists: true, downloadContent: rawBytes });
    // Should not throw
    await expect(
      runRetriggerProcessing("ev-001", "user-001", db, bucket, new KMSMock(), makeLogger())
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FILE_NOT_FOUND path
// ---------------------------------------------------------------------------

describe("retriggerProcessing — FILE_NOT_FOUND", () => {
  it("returns FILE_NOT_FOUND and logs a warning when Storage file is absent", async () => {
    const { db } = makeDb(makeDocData({ status: "uploading" }));
    const { bucket } = makeBucket({ fileExists: false });
    const logger = makeLogger();

    const result = await runRetriggerProcessing("ev-001", "user-001", db, bucket, new KMSMock(), logger);

    expect(result.outcome).toBe("FILE_NOT_FOUND");
    const warnMsgs = logger.messages.filter(m => m.level === "warn" && m.text.includes("re-upload"));
    expect(warnMsgs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Happy path: pipeline is re-run
// ---------------------------------------------------------------------------

describe("retriggerProcessing — happy path", () => {
  it("returns RETRIGGERED and completes the pipeline to 'available'", async () => {
    const rawBytes = Buffer.from("real evidence file");
    const sha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
    const { db, updates } = makeDb(makeDocData({
      status: "uploading",
      sha256Hash: sha256,
      updatedAt: recentDate(5_000),
    }));
    const { bucket } = makeBucket({ fileExists: true, downloadContent: rawBytes });
    const logger = makeLogger();

    const result = await runRetriggerProcessing(
      "ev-001", "user-001", db, bucket, new KMSMock(), logger
    );

    expect(result.outcome).toBe("RETRIGGERED");
    // Pipeline ran to completion — document should reach 'available'
    const availableUpdate = updates.find(u => u["status"] === "available");
    expect(availableUpdate).toBeDefined();
    expect(availableUpdate!["encryptionKeyRef"]).toBeTruthy();
    expect(availableUpdate!["retentionExpiresAt"]).toBeInstanceOf(Date);
  });
});
