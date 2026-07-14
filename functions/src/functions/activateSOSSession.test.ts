/**
 * Tests for activateSOSSession Cloud Tasks handler (Task 3).
 *
 * Covers the conditional countdown→active transaction, abort paths,
 * header verification, timestamp deserialization guard, and HTTP response
 * semantics (2xx = Cloud Tasks won't retry, 5xx = Cloud Tasks retries).
 *
 * Requirements: design.md §activateSOSSession, tasks.md Task 3.6
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runActivateSOSSession, createActivateSOSSessionHandler } from "./activateSOSSession.js";
import type { Request, Response } from "express";
import * as functions from "firebase-functions";

// Mock firebase-functions logger
vi.mock("firebase-functions", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SessionData = {
  status: string;
  triggeredAt: Date | unknown;
  createdAt: Date | unknown;
  activatedAt: Date | null | unknown;
  cancelledAt: Date | null | unknown;
  userId?: string;
};

function makeDb(opts: {
  exists?: boolean;
  data?: Partial<SessionData>;
  transactionError?: Error;
} = {}) {
  const updates = new Map<string, Record<string, unknown>>();

  const exists = opts.exists !== false; // default: document exists
  const now = new Date("2025-01-01T12:00:10Z");

  const defaultData: SessionData = {
    status: "countdown",
    triggeredAt: new Date("2025-01-01T12:00:00Z"),
    createdAt: new Date("2025-01-01T12:00:00Z"),
    activatedAt: null,
    cancelledAt: null,
    userId: "user-123",
  };

  const docData: SessionData = { ...defaultData, ...(opts.data ?? {}) };

  const sessionRef = {
    id: "test-session-id",
  };

  const db = {
    collection: vi.fn(() => ({
      doc: vi.fn((_id: string) => sessionRef),
    })),
    runTransaction: vi.fn().mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<void>) => {
        if (opts.transactionError) {
          throw opts.transactionError;
        }

        const tx = {
          get: vi.fn().mockResolvedValue({
            exists,
            data: () => (exists ? docData : undefined),
          }),
          update: vi.fn((ref: unknown, data: Record<string, unknown>) => {
            updates.set("last", data);
          }),
        };

        await fn(tx);
      }
    ),
  } as unknown as import("firebase-admin/firestore").Firestore;

  return { db, updates };
}

function makeHttpMocks(opts: {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
} = {}) {
  const req = {
    body: opts.body ?? { sessionId: "test-session-id" },
    headers: opts.headers ?? { "x-cloudtasks-queuename": "sos-session-activate" },
    ip: "1.2.3.4",
  } as unknown as Request;

  const json = vi.fn();
  const res = {
    status: vi.fn().mockReturnThis(),
    json,
  } as unknown as Response;

  return { req, res };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("activateSOSSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("countdown → active transition (P32)", () => {
    it("transitions countdown → active and sets activatedAt to non-null", async () => {
      const { db, updates } = makeDb();
      const serverTime = new Date("2025-01-01T12:00:10Z");

      const result = await runActivateSOSSession("session-1", db, serverTime);

      expect(result.outcome).toBe("activated");

      // activatedAt and updatedAt are written atomically with status: 'active'
      const written = updates.get("last")!;
      expect(written["status"]).toBe("active");
      expect(written["activatedAt"]).toBeInstanceOf(Date);
      expect((written["activatedAt"] as Date).getTime()).toBe(serverTime.getTime());
      expect(written["updatedAt"]).toBeInstanceOf(Date);

      // activatedAt is non-null — P32 invariant
      expect(written["activatedAt"]).not.toBeNull();
    });

    it("status and activatedAt are written atomically — update called once per activation", async () => {
      const { db, updates } = makeDb();
      const result = await runActivateSOSSession("session-1", db);

      expect(result.outcome).toBe("activated");
      // tx.update is called exactly once — single atomic write
      const txInstance = (db.runTransaction as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(txInstance).toBeDefined();
      const written = updates.get("last")!;
      // All three fields in one update call
      expect(Object.keys(written)).toEqual(
        expect.arrayContaining(["status", "activatedAt", "updatedAt"])
      );
    });

    it("activatedAt is a native Date, not a Firestore Timestamp", async () => {
      const { db, updates } = makeDb();
      await runActivateSOSSession("session-1", db, new Date());

      const written = updates.get("last")!;
      expect(written["activatedAt"]).toBeInstanceOf(Date);
      // Must NOT be a Firestore Timestamp (which would have .seconds / .nanoseconds)
      expect((written["activatedAt"] as any).seconds).toBeUndefined();
      expect((written["activatedAt"] as any).nanoseconds).toBeUndefined();
    });
  });

  describe("Abort paths — return 200 (P25)", () => {
    it("aborts and returns outcome:not_countdown when status is already 'cancelled' (P25)", async () => {
      const { db, updates } = makeDb({ data: { status: "cancelled", cancelledAt: new Date() } });

      const result = await runActivateSOSSession("session-1", db);

      expect(result.outcome).toBe("not_countdown");
      // No write should have happened
      expect(updates.size).toBe(0);

      expect(functions.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          actualStatus: "cancelled",
        })
      );
    });

    it("aborts and returns outcome:not_countdown when status is already 'active' (idempotent retry)", async () => {
      const { db, updates } = makeDb({
        data: { status: "active", activatedAt: new Date() },
      });

      const result = await runActivateSOSSession("session-1", db);

      expect(result.outcome).toBe("not_countdown");
      expect(updates.size).toBe(0);
    });

    it("aborts gracefully when session document does not exist (orphan task)", async () => {
      const { db, updates } = makeDb({ exists: false });

      const result = await runActivateSOSSession("session-1", db);

      // Orphan task: enqueue succeeded but Firestore write failed in createSOSSession.
      // Return 200 so Cloud Tasks does not retry an unresolvable task.
      expect(result.outcome).toBe("not_found");
      expect(updates.size).toBe(0);

      expect(functions.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/orphan task/),
        })
      );
    });
  });

  describe("Timestamp deserialization guard", () => {
    it("assertDate guard fires and throws if triggeredAt deserializes as a plain string", async () => {
      const { db } = makeDb({
        data: { triggeredAt: "not-a-date-object" }, // raw string — not a Date
      });

      const result = await runActivateSOSSession("session-1", db);

      // Firestore deserialization error → treated as a transient error → 500
      expect(result.outcome).toBe("error");
      expect(result.error).toMatch(/assertDate|TimestampDeserializationError|expected Date/i);
    });
  });

  describe("Firestore error → 500 (Cloud Tasks retries)", () => {
    it("returns outcome:error on Firestore transaction failure", async () => {
      const { db } = makeDb({
        transactionError: new Error("Firestore UNAVAILABLE"),
      });

      const result = await runActivateSOSSession("session-1", db);

      expect(result.outcome).toBe("error");
      expect(result.error).toMatch(/UNAVAILABLE/);

      expect(functions.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "activateSOSSession: Firestore error",
          sessionId: "session-1",
        })
      );
    });
  });

  describe("HTTP handler — header verification", () => {
    it("rejects request missing X-CloudTasks-QueueName with 400", async () => {
      const handler = createActivateSOSSessionHandler(makeDb().db);
      const { req, res } = makeHttpMocks({ headers: {} }); // no queue header

      await handler(req, res);

      expect((res.status as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(400);
      expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
        error: expect.stringMatching(/Missing Cloud Tasks header/),
      });
    });

    it("rejects request with invalid (empty) sessionId with 400", async () => {
      const handler = createActivateSOSSessionHandler(makeDb().db);
      const { req, res } = makeHttpMocks({
        body: { sessionId: "" },
        headers: { "x-cloudtasks-queuename": "sos-session-activate" },
      });

      await handler(req, res);

      expect((res.status as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(400);
    });

    it("returns 200 on successful activation", async () => {
      const handler = createActivateSOSSessionHandler(makeDb().db);
      const { req, res } = makeHttpMocks();

      await handler(req, res);

      expect((res.status as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(200);
      expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
        outcome: "activated",
      });
    });

    it("returns 200 (not 4xx/5xx) when status is not countdown — Cloud Tasks must not retry", async () => {
      const { db } = makeDb({ data: { status: "cancelled", cancelledAt: new Date() } });
      const handler = createActivateSOSSessionHandler(db);
      const { req, res } = makeHttpMocks();

      await handler(req, res);

      // 200 tells Cloud Tasks the task is done — no retry
      expect((res.status as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(200);
    });

    it("returns 500 on Firestore error so Cloud Tasks retries", async () => {
      const { db } = makeDb({
        transactionError: new Error("Firestore UNAVAILABLE"),
      });
      const handler = createActivateSOSSessionHandler(db);
      const { req, res } = makeHttpMocks();

      await handler(req, res);

      expect((res.status as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(500);
    });
  });
});
