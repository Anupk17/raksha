/**
 * Tests for the client upload orchestrator (Phase 10, tasks 10.3–10.6).
 *
 * Property 4: Upload Idempotency
 * Requirements: 1.1, 1.2, 1.7, 2.1–2.7
 */
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import crypto from "crypto";
import { captureEvidence } from "./captureEvidence.js";
import { MAX_FILE_SIZE_BYTES } from "./validateFile.js";
import type { FirestoreAdapter, StorageAdapter, FunctionsAdapter } from "./captureEvidence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(mimeType = "image/jpeg", sizeBytes = 1024) {
  const data = crypto.randomBytes(sizeBytes);
  return {
    name: "photo.jpg",
    type: mimeType,
    size: sizeBytes,
    arrayBuffer: async () => data.buffer as ArrayBuffer,
    _data: data,
  };
}

const defaultMetadata = {
  incidentId: "inc-001",
  capturedAt: new Date("2024-01-01"),
  deviceInfo: "test",
  locationHash: null,
  incidentContext: null,
};

function sha256hash(data: ArrayBuffer): Promise<string> {
  return Promise.resolve(
    crypto.createHash("sha256").update(Buffer.from(data)).digest("hex")
  );
}

function makeAdapters(opts: {
  existingDoc?: Record<string, unknown> | null;
  storageFailure?: boolean;
  reportUploadFailureOutcome?: string;
  retriggerOutcome?: string;
} = {}) {
  const created: unknown[] = [];
  const uploads: unknown[] = [];

  const firestore: FirestoreAdapter = {
    createDocument: vi.fn(async (id, doc) => { created.push({ id, doc }); }),
    getDocument: vi.fn(async () => opts.existingDoc ?? null),
    getDocumentWithRetry: vi.fn(async () => opts.existingDoc ?? null),
  };

  const storage: StorageAdapter = {
    upload: vi.fn(async () => {
      if (opts.storageFailure) throw new Error("Storage unavailable");
      uploads.push(true);
    }),
  };

  const functions: FunctionsAdapter = {
    call: vi.fn(async (name) => {
      if (name === "reportUploadFailure") return { outcome: opts.reportUploadFailureOutcome ?? "FAILED" };
      if (name === "retriggerProcessing") return { outcome: opts.retriggerOutcome ?? "RETRIGGERED" };
      return {};
    }),
  };

  return { firestore, storage, functions, created, uploads };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe("captureEvidence — file validation (Req 1.1)", () => {
  it("rejects unsupported MIME type without touching Firestore or Storage", async () => {
    const { firestore, storage, functions } = makeAdapters();
    const file = makeFile("application/x-unsupported");
    const result = await captureEvidence("ev-001", file, "user-001", defaultMetadata, firestore, storage, functions, sha256hash);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("VALIDATION_ERROR");
    expect(firestore.createDocument).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("rejects files > 100 MB (P1)", async () => {
    const { firestore, storage, functions } = makeAdapters();
    const file = makeFile("image/jpeg", MAX_FILE_SIZE_BYTES + 1);
    const result = await captureEvidence("ev-001", file, "user-001", defaultMetadata, firestore, storage, functions, sha256hash);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Fresh upload path
// ---------------------------------------------------------------------------
describe("captureEvidence — fresh upload (Req 1.3, 1.4)", () => {
  it("creates Firestore document before Storage upload", async () => {
    const { firestore, storage, functions, created, uploads } = makeAdapters({ existingDoc: null });
    const file = makeFile();
    const result = await captureEvidence("ev-001", file, "user-001", defaultMetadata, firestore, storage, functions, sha256hash);
    expect(result.success).toBe(true);
    // Document must be created before upload — verified by call order
    const createOrder = (firestore.createDocument as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const uploadOrder = (storage.upload as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(createOrder).toBeLessThan(uploadOrder);
    expect(created.length).toBe(1);
    expect(uploads.length).toBe(1);
  });

  it("document has status:uploading and all required fields with native Date timestamps", async () => {
    const { firestore, created } = makeAdapters({ existingDoc: null });
    const file = makeFile();
    await captureEvidence("ev-001", file, "user-001", defaultMetadata, firestore, { upload: vi.fn() }, { call: vi.fn() }, sha256hash);
    const doc = (created[0] as { id: string; doc: Record<string, unknown> }).doc;
    expect(doc["status"]).toBe("uploading");
    expect(doc["evidenceId"]).toBe("ev-001");
    expect(doc["userId"]).toBe("user-001");
    expect(doc["sha256Hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(doc["createdAt"]).toBeInstanceOf(Date); // native Date (Req 10.1)
    expect(doc["updatedAt"]).toBeInstanceOf(Date);
    expect((doc["metadata"] as Record<string, unknown>)["capturedAt"]).toBeInstanceOf(Date);
  });

  it("does NOT attempt Storage upload if Firestore creation fails (Req 1.7)", async () => {
    const { storage, functions } = makeAdapters();
    const firestore: FirestoreAdapter = {
      createDocument: vi.fn().mockRejectedValue(new Error("Firestore write failed")),
      getDocument: vi.fn().mockResolvedValue(null),
      getDocumentWithRetry: vi.fn().mockResolvedValue(null),
    };
    const file = makeFile();
    const result = await captureEvidence("ev-001", file, "user-001", defaultMetadata, firestore, storage, functions, sha256hash);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("FIRESTORE_CREATE_FAILED");
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("calls reportUploadFailure (not direct Firestore write) on Storage failure (Req 1.8)", async () => {
    const { firestore, functions } = makeAdapters({ storageFailure: true, reportUploadFailureOutcome: "FAILED" });
    const file = makeFile();
    const result = await captureEvidence("ev-001", file, "user-001", defaultMetadata, firestore, { upload: vi.fn().mockRejectedValue(new Error("fail")) }, functions, sha256hash);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("STORAGE_TRANSFER_FAILED");
    expect(functions.call).toHaveBeenCalledWith("reportUploadFailure", { evidenceId: "ev-001" });
  });

  it("returns UPLOAD_IN_PROGRESS when reportUploadFailure returns ALREADY_PROCESSING", async () => {
    const { firestore, functions } = makeAdapters({ storageFailure: true, reportUploadFailureOutcome: "ALREADY_PROCESSING" });
    const file = makeFile();
    const result = await captureEvidence("ev-001", file, "user-001", defaultMetadata, firestore, { upload: vi.fn().mockRejectedValue(new Error("fail")) }, functions, sha256hash);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("UPLOAD_IN_PROGRESS");
  });
});

// ---------------------------------------------------------------------------
// Idempotency branches — Property 4
// ---------------------------------------------------------------------------
describe("captureEvidence — idempotency branches (P4, Req 2.1–2.4)", () => {
  it("P4: returns success immediately for COMPLETE_DUPLICATE (status:available)", async () => {
    // Feature: evidence-trail, Property 4: Upload Idempotency
    const { firestore, storage, functions } = makeAdapters({
      existingDoc: { status: "available", updatedAt: new Date() },
    });
    const result = await captureEvidence("ev-001", makeFile(), "user-001", defaultMetadata, firestore, storage, functions, sha256hash);
    expect(result.success).toBe(true);
    if (result.success) expect(result.idempotent).toBe(true);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(firestore.createDocument).not.toHaveBeenCalled();
  });

  it("returns CONCURRENT_UPLOAD error for a freshly-active document (updatedAt < 300s)", async () => {
    const { firestore, storage, functions } = makeAdapters({
      existingDoc: { status: "uploading", updatedAt: new Date(Date.now() - 100_000) },
    });
    const result = await captureEvidence("ev-001", makeFile(), "user-001", defaultMetadata, firestore, storage, functions, sha256hash);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("CONCURRENT_UPLOAD");
  });

  it("calls retriggerProcessing for a stalled document (updatedAt > 300s)", async () => {
    const staleDate = new Date(Date.now() - 400_000);
    const { firestore, storage, functions } = makeAdapters({
      existingDoc: { status: "uploading", updatedAt: staleDate },
      retriggerOutcome: "RETRIGGERED",
    });
    const result = await captureEvidence("ev-001", makeFile(), "user-001", defaultMetadata, firestore, storage, functions, sha256hash);
    expect(functions.call).toHaveBeenCalledWith("retriggerProcessing", { evidenceId: "ev-001" });
    expect(result.success).toBe(true);
  });

  it("returns TERMINAL_FAILURE for a failed document — no retry on same evidenceId (Req 2.7)", async () => {
    const { firestore, storage, functions } = makeAdapters({
      existingDoc: { status: "failed", updatedAt: new Date() },
    });
    const result = await captureEvidence("ev-001", makeFile(), "user-001", defaultMetadata, firestore, storage, functions, sha256hash);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("TERMINAL_FAILURE");
    expect(firestore.createDocument).not.toHaveBeenCalled();
  });
});
