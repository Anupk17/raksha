/**
 * Tests for createSOSSession Cloud Function (Task 2).
 *
 * Covers all validation, idempotency, rate-limiting, and Cloud Tasks scheduling
 * logic for the discreet silent activation entry point.
 *
 * Requirements: design.md §createSOSSession, tasks.md Task 2.10
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCreateSOSSession } from "./createSOSSession.js";
import { CloudTasksMock } from "../cloudTasks/CloudTasksMock.js";
import crypto from "crypto";
import type { CreateSOSSessionPayload } from "../types/sosSession.js";
import * as functions from "firebase-functions";

// Mock firebase-functions logger
vi.mock("firebase-functions", () => {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(opts: { existingSessions?: any[]; rateLimitCount?: number } = {}) {
  const writtenDocs = new Map<string, any>();

  // sessionRef returned by collection().doc() — used for the post-enqueue set()
  const sessionRefMock = {
    id: "auto-session-id",
    set: vi.fn(async (_data: any) => {
      writtenDocs.set("auto-session-id", _data);
    }),
  };

  const collectionMock: any = {
    doc: vi.fn((docId) => {
      if (docId) {
        const specificRef = {
          id: docId,
          set: vi.fn(async (data: any) => {
            writtenDocs.set(docId, data);
          }),
        };
        return specificRef;
      }
      return sessionRefMock;
    }),
    where: vi.fn().mockReturnThis(),
  };

  let getCallCount = 0;

  const db = {
    collection: vi.fn(() => collectionMock),
    runTransaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: vi.fn().mockImplementation(async () => {
          if (getCallCount === 0) {
            getCallCount++;
            // 1st get: Idempotency check
            const docs = opts.existingSessions ?? [];
            return {
              empty: docs.length === 0,
              docs: docs.map((d, i) => ({
                id: `existing-doc-${i}`,
                data: () => d,
              })),
            };
          } else {
            getCallCount++;
            // 2nd get: Rate limit check
            return {
              size: opts.rateLimitCount ?? 0,
            };
          }
        }),
      };
      await fn(tx);
    }),
  } as unknown as import("firebase-admin/firestore").Firestore;

  return { db, writtenDocs };
}

function makePayload(overrides: Partial<CreateSOSSessionPayload> = {}): CreateSOSSessionPayload {
  const now = new Date();
  return {
    triggerType: "earbud",
    triggeredAt: now.toISOString(),
    syncedAt: now.toISOString(),
    location: null,
    deviceInfo: "test-device",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSOSSession", () => {
  let tasksMock: CloudTasksMock;
  const QUEUE_PATH = "projects/test/locations/test/queues/sos";
  const HANDLER_URL = "https://example.com/handler";
  const CALLER_UID = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
    tasksMock = new CloudTasksMock();
  });

  describe("Validation", () => {
    it("rejects unauthenticated request (401)", async () => {
      const { db } = makeDb();
      const err = await runCreateSOSSession(makePayload(), "", db, tasksMock, QUEUE_PATH, HANDLER_URL).catch((e) => e);
      expect(err.code).toBe("UNAUTHENTICATED");
    });

    it("rejects missing payload", async () => {
      const { db } = makeDb();
      const err = await runCreateSOSSession(null as any, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL).catch((e) => e);
      expect(err.code).toBe("INVALID_ARGUMENT");
    });

    it("rejects invalid triggerType (400)", async () => {
      const { db } = makeDb();
      const payload = makePayload({ triggerType: "invalid" as any });
      const err = await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL).catch((e) => e);
      expect(err.code).toBe("INVALID_ARGUMENT");
      expect(err.message).toMatch(/invalid triggerType/);
    });

    it("rejects triggeredAt in the future > 5s tolerance (400)", async () => {
      const { db } = makeDb();
      const serverTime = new Date("2025-01-01T12:00:00Z");
      const futureTime = new Date("2025-01-01T12:00:10Z"); // 10s future
      const payload = makePayload({ triggeredAt: futureTime.toISOString() });
      
      const err = await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime).catch((e) => e);
      expect(err.code).toBe("INVALID_ARGUMENT");
      expect(err.message).toMatch(/in the future/);
    });

    it("accepts triggeredAt in the future <= 5s tolerance", async () => {
      const { db, writtenDocs } = makeDb();
      const serverTime = new Date("2025-01-01T12:00:00Z");
      const futureTime = new Date("2025-01-01T12:00:04Z"); // 4s future
      const payload = makePayload({ triggeredAt: futureTime.toISOString() });
      
      const res = await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime);
      expect(res.sessionId).toBeDefined();
      expect(writtenDocs.size).toBe(1);
    });

    it("rejects triggeredAt older than 72 hours (400)", async () => {
      const { db } = makeDb();
      const serverTime = new Date("2025-01-04T12:00:00Z");
      const oldTime = new Date("2025-01-01T11:00:00Z"); // 73 hours past
      const payload = makePayload({ triggeredAt: oldTime.toISOString() });
      
      const err = await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime).catch((e) => e);
      expect(err.code).toBe("INVALID_ARGUMENT");
      expect(err.message).toMatch(/older than 72 hours/);
    });
  });

  describe("Document Creation & Timestamps", () => {
    it("creates document with status: 'countdown' and native Date fields", async () => {
      const { db, writtenDocs } = makeDb();
      const serverTime = new Date("2025-01-01T12:00:00Z");
      const triggeredTime = new Date("2025-01-01T11:59:55Z");
      const payload = makePayload({
        triggeredAt: triggeredTime.toISOString(),
        syncedAt: serverTime.toISOString(),
      });

      const res = await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime);
      
      expect(res.status).toBe("countdown");
      expect(writtenDocs.size).toBe(1);
      
      const doc = writtenDocs.get(res.sessionId);
      expect(doc.status).toBe("countdown");
      expect(doc.userId).toBe(CALLER_UID);
      
      // CRITICAL: timestamps must be native Dates
      expect(doc.triggeredAt).toBeInstanceOf(Date);
      expect(doc.createdAt).toBeInstanceOf(Date);
      
      // P23: triggeredAt matches client payload exactly
      expect(doc.triggeredAt.getTime()).toBe(triggeredTime.getTime());
      
      // createdAt matches server time
      expect(doc.createdAt.getTime()).toBe(serverTime.getTime());
    });

    it("computes lateSyncFlag: false for real-time trigger", async () => {
      const { db, writtenDocs } = makeDb();
      const time = new Date("2025-01-01T12:00:00Z");
      const payload = makePayload({
        triggeredAt: time.toISOString(),
        syncedAt: time.toISOString(),
      });

      const res = await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, time);
      const doc = writtenDocs.get(res.sessionId);
      
      expect(doc.syncDelayMinutes).toBe(0);
      expect(doc.lateSyncFlag).toBe(false);
      expect(res.status).toBe("countdown"); // Not activated yet
    });

    it("computes lateSyncFlag: true when syncDelayMinutes >= 60 (P24)", async () => {
      const { db, writtenDocs } = makeDb();
      const serverTime = new Date("2025-01-01T12:00:00Z");
      const triggeredTime = new Date("2025-01-01T10:00:00Z"); // 2 hours late
      const payload = makePayload({
        triggeredAt: triggeredTime.toISOString(),
        syncedAt: serverTime.toISOString(),
      });

      const res = await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime);
      const doc = writtenDocs.get(res.sessionId);
      
      expect(doc.syncDelayMinutes).toBe(120);
      expect(doc.lateSyncFlag).toBe(true);
      
      // Elapsed by server time > 10s
      expect(res.status).toBe("active"); 
      // Note: written status is still 'countdown' as Cloud Tasks handler does the write later.
      expect(doc.status).toBe("countdown"); 
    });
  });

  describe("Idempotency (P29)", () => {
    it("returns existing sessionId and alreadyExists: true if identical trigger found", async () => {
      const { db, writtenDocs } = makeDb({
        existingSessions: [{ status: "countdown" }],
      });
      const serverTime = new Date();
      const payload = makePayload();

      const res = await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime);
      
      expect(res.alreadyExists).toBe(true);
      expect(res.sessionId).toBe("existing-doc-0");
      expect(res.status).toBe("countdown");
      
      // No new document written
      expect(writtenDocs.size).toBe(0);
      // No tasks enqueued
      expect(tasksMock.taskCount).toBe(0);
    });
  });

  describe("Rate Limiting (P30)", () => {
    it("rejects 6th call within 10 minutes with 429", async () => {
      const { db, writtenDocs } = makeDb({ rateLimitCount: 5 });
      const serverTime = new Date();
      
      const err = await runCreateSOSSession(makePayload(), CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime).catch((e) => e);
      expect(err.code).toBe("RESOURCE_EXHAUSTED");
      
      // Expect warning log
      expect(functions.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/rate-limit exceeded/),
          windowCount: 5,
        })
      );
      
      expect(writtenDocs.size).toBe(0);
      expect(tasksMock.taskCount).toBe(0);
    });
  });

  describe("Cloud Tasks Enqueue", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("enqueues Cloud Tasks task with scheduleTime = triggeredAt + 10s for real-time trigger", async () => {
      const { db } = makeDb();
      const serverTime = new Date("2025-01-01T12:00:00.000Z");
      vi.setSystemTime(serverTime);
      const triggeredTime = new Date("2025-01-01T11:59:58.000Z"); // 2s ago
      const payload = makePayload({ triggeredAt: triggeredTime.toISOString() });
      
      const res = await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime);
      
      expect(tasksMock.taskCount).toBe(1);
      const task = tasksMock.lastTask!;
      expect(task.queuePath).toBe(QUEUE_PATH);
      expect(task.handlerUrl).toBe(HANDLER_URL);
      expect(task.payload).toEqual({ sessionId: res.sessionId });
      
      // Should be scheduled at triggeredTime + 10s
      expect(task.scheduleMs).toBe(triggeredTime.getTime() + 10000);
    });

    it("enqueues with minimum 100ms future padding for late-sync triggers", async () => {
      const { db } = makeDb();
      const serverTime = new Date("2025-01-01T12:00:00.000Z");
      vi.setSystemTime(serverTime);
      const triggeredTime = new Date("2025-01-01T11:00:00.000Z"); // 1h ago
      const payload = makePayload({ triggeredAt: triggeredTime.toISOString() });
      
      await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime);
      
      const task = tasksMock.lastTask!;
      // Since triggeredAt + 10s is far in the past, it clamps to serverReceiveTime + 100ms
      expect(task.scheduleMs).toBe(serverTime.getTime() + 100);
    });

    it("throws INTERNAL and writes NO document when Cloud Tasks throws (no stuck state)", async () => {
      const { db, writtenDocs } = makeDb();
      const serverTime = new Date();

      // Mock Cloud Tasks to fail
      vi.spyOn(tasksMock, "enqueueTask").mockRejectedValue(new Error("Queue missing"));

      const err = await runCreateSOSSession(makePayload(), CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime).catch((e) => e);
      expect(err.code).toBe("INTERNAL");
      expect(err.message).toMatch(/Failed to enqueue/);

      // CRITICAL: no document is written — there is no stuck 'countdown' document
      // with no activation task behind it. Clean failure, client can safely retry.
      expect(writtenDocs.size).toBe(0);

      // Error log should be written
      expect(functions.logger.error).toHaveBeenCalled();
    });

    it("does not double-enqueue when retried with the same sessionId (named-task dedup)", async () => {
      const { db } = makeDb();
      const serverTime = new Date("2025-01-01T12:00:00.000Z");
      vi.setSystemTime(serverTime);
      const payload = makePayload({ triggeredAt: "2025-01-01T11:59:58.000Z" });

      // First call
      const res1 = await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime);
      expect(tasksMock.taskCount).toBe(1);
      const task1Name = tasksMock.lastTask!.taskName;
      expect(task1Name).toBe(`activate-${res1.sessionId}`);

      // Simulate a retry with the same stable task name (e.g. process crashed
      // after enqueue but before Firestore write, caller retried). The mock
      // returns the existing task without re-recording it.
      const secondResult = await tasksMock.enqueueTask(
        QUEUE_PATH, HANDLER_URL, { sessionId: res1.sessionId },
        serverTime.getTime() + 10000,
        `activate-${res1.sessionId}`
      );
      // Still only 1 task recorded — dedup worked
      expect(tasksMock.taskCount).toBe(1);
      expect(secondResult).toBe(task1Name);
    });
  });

  describe("Audit Logs", () => {
    it("writes audit log with hashed userId and no sub-second precision", async () => {
      const { db } = makeDb();
      const serverTime = new Date("2025-01-01T12:00:00.123Z");
      const payload = makePayload({
        triggeredAt: "2025-01-01T11:59:58.456Z"
      });
      
      await runCreateSOSSession(payload, CALLER_UID, db, tasksMock, QUEUE_PATH, HANDLER_URL, serverTime);
      
      const expectedHashedUid = crypto.createHash("sha256").update(CALLER_UID).digest("hex").slice(0, 16);
      
      expect(functions.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: expectedHashedUid,
          triggeredAt: "2025-01-01T11:59:58Z", // No .456
          createdAt: "2025-01-01T12:00:00Z",   // No .123
        })
      );
    });
  });
});
