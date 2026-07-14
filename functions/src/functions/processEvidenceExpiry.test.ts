/**
 * Tests for processEvidenceExpiry (Phase 7).
 * Requirements: 8.2, 8.3, 8.4, 8.7
 * Property 14: Legal Hold Preservation
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { runProcessEvidenceExpiry } from "./processEvidenceExpiry.js";
import type { PipelineLogger } from "./onEvidenceCreate/pipeline.js";
import type { ChainOfCustodyEntry } from "../types/evidence.js";

function makeLogger(): PipelineLogger & { messages: { level: string; text: string }[] } {
  const messages: { level: string; text: string }[] = [];
  return {
    messages,
    info:  (t) => messages.push({ level: "info",  text: t }),
    warn:  (t) => messages.push({ level: "warn",  text: t }),
    error: (t) => messages.push({ level: "error", text: t }),
  };
}

afterEach(() => {
  delete process.env["EVIDENCE_RETENTION_DAYS"];
});

function makeDocSnap(id: string, status: string, retentionExpiresAt: Date) {
  const data = {
    evidenceId: id, incidentId: "inc-001", userId: "user-001",
    type: "photo", storageRef: `evidence/${id}/photo.jpg`,
    originalFilename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 1024,
    sha256Hash: "a".repeat(64), encryptionKeyRef: "kref", encryptionIV: "aWlu",
    status, retentionExpiresAt, legalHoldReason: null, chainOfCustody: [],
    createdAt: new Date("2024-01-01"), updatedAt: new Date("2024-01-01"),
    metadata: { capturedAt: new Date("2024-01-01"), deviceInfo: "test", locationHash: null, incidentContext: null },
  };
  return { id, ref: { path: `evidence/${id}` }, data: () => ({ ...data }) };
}

function makeDb(
  docs: ReturnType<typeof makeDocSnap>[],
  txStatusOverrides: Record<string, string> = {}
) {
  const updates: Record<string, Record<string, unknown>> = {};

  const db = {
    collection: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({ size: docs.length, docs }),
    }),
    runTransaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      // We need a closure per doc — vitest runs them sequentially in singleFork mode
      const tx = {
        get: vi.fn().mockImplementation(async (ref: { path: string }) => {
          const docId = ref.path.split("/")[1]!;
          const overrideStatus = txStatusOverrides[docId];
          const doc = docs.find(d => d.id === docId);
          if (!doc) return { exists: false };
          const data = doc.data();
          return {
            exists: true,
            data: () => ({ ...data, status: overrideStatus ?? data.status }),
          };
        }),
        update: vi.fn((_ref: { path: string }, data: Record<string, unknown>) => {
          const docId = _ref.path.split("/")[1]!;
          updates[docId] = data;
        }),
      };
      await fn(tx);
    }),
  } as unknown as import("firebase-admin/firestore").Firestore;

  return { db, updates };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------
describe("processEvidenceExpiry — config validation (Req 8.7)", () => {
  it("aborts the entire run and throws when EVIDENCE_RETENTION_DAYS is invalid", async () => {
    process.env["EVIDENCE_RETENTION_DAYS"] = "0";
    const { db } = makeDb([]);
    const logger = makeLogger();
    await expect(runProcessEvidenceExpiry(db, logger)).rejects.toThrow(RangeError);
    const criticalMsgs = logger.messages.filter(m => m.level === "error" && m.text.includes("CRITICAL"));
    expect(criticalMsgs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Happy path: eligible documents transitioned to expired
// ---------------------------------------------------------------------------
describe("processEvidenceExpiry — eligible documents expired (Req 8.2, 8.4)", () => {
  it("transitions an eligible document to expired with a status_changed custody entry", async () => {
    process.env["EVIDENCE_RETENTION_DAYS"] = "90";
    const pastDate = new Date(Date.now() - 1000);
    const doc = makeDocSnap("ev-001", "available", pastDate);
    const { db, updates } = makeDb([doc]);

    const result = await runProcessEvidenceExpiry(db, makeLogger());

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(updates["ev-001"]!["status"]).toBe("expired");
    const custody = updates["ev-001"]!["chainOfCustody"] as ChainOfCustodyEntry[];
    expect(custody).toHaveLength(1);
    expect(custody[0]!.action).toBe("status_changed");
    expect(custody[0]!.performedBy).toBe("cloud_function");
    expect(custody[0]!.timestamp).toBeInstanceOf(Date); // native Date (Req 10.1)
    expect(custody[0]!.metadata?.["priorStatus"]).toBe("available");
    expect(custody[0]!.metadata?.["newStatus"]).toBe("expired");
  });

  it("processes multiple documents and reports totals", async () => {
    process.env["EVIDENCE_RETENTION_DAYS"] = "90";
    const past = new Date(Date.now() - 1000);
    const docs = [
      makeDocSnap("ev-001", "available", past),
      makeDocSnap("ev-002", "available", past),
    ];
    const { db } = makeDb(docs);

    const result = await runProcessEvidenceExpiry(db, makeLogger());

    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Legal hold preservation (Property 14)
// ---------------------------------------------------------------------------
describe("processEvidenceExpiry — legal hold protection (Req 8.3, P14)", () => {
  it("P14: skips a document that was concurrently moved to legal_hold between query and commit", async () => {
    process.env["EVIDENCE_RETENTION_DAYS"] = "90";
    const past = new Date(Date.now() - 1000);
    const doc = makeDocSnap("ev-001", "available", past);
    // Tx read sees legal_hold (concurrent setLegalHold won the race)
    const { db, updates } = makeDb([doc], { "ev-001": "legal_hold" });
    const logger = makeLogger();

    await runProcessEvidenceExpiry(db, logger);

    expect(updates["ev-001"]).toBeUndefined(); // no write committed
    const skipLogs = logger.messages.filter(m => m.text.includes("Skipped") && m.text.includes("ev-001"));
    expect(skipLogs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Continue-on-failure (Req 8.2)
// ---------------------------------------------------------------------------
describe("processEvidenceExpiry — continue-on-failure (Req 8.2)", () => {
  it("logs individual document failures and continues processing remaining documents", async () => {
    process.env["EVIDENCE_RETENTION_DAYS"] = "90";
    const past = new Date(Date.now() - 1000);
    const docs = [
      makeDocSnap("ev-fail", "available", past),
      makeDocSnap("ev-ok", "available", past),
    ];

    let callCount = 0;
    const db = {
      collection: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue({ size: 2, docs }),
      }),
      runTransaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        callCount++;
        if (callCount === 1) throw new Error("Firestore transient error");
        const doc = docs[callCount - 1]!;
        const tx = {
          get: vi.fn().mockResolvedValue({ exists: true, data: () => doc.data() }),
          update: vi.fn(),
        };
        await fn(tx);
      }),
    } as unknown as import("firebase-admin/firestore").Firestore;

    const logger = makeLogger();
    const result = await runProcessEvidenceExpiry(db, logger);

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    const errorLogs = logger.messages.filter(m => m.level === "error" && m.text.includes("ev-fail"));
    expect(errorLogs).toHaveLength(1);
  });
});
