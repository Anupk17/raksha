/**
 * Tests for cancelSOSSession Cloud Function (Task 4).
 *
 * Covers: auth, ownership, conditional transaction (countdown→cancelled),
 * idempotent re-cancel (P26 variant), already-active rejection (P26),
 * and timestamp discipline.
 *
 * Requirements: design.md §cancelSOSSession, tasks.md Task 4.4
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCancelSOSSession } from "./cancelSOSSession.js";
import * as functions from "firebase-functions";

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
  userId: string;
  triggeredAt: Date | unknown;
  createdAt: Date | unknown;
  activatedAt: Date | null;
  cancelledAt: Date | null;
};

function makeDb(opts: {
  exists?: boolean;
  data?: Partial<SessionData>;
  transactionError?: Error;
} = {}) {
  const updates = new Map<string, Record<string, unknown>>();

  const exists = opts.exists !== false;

  const defaultData: SessionData = {
    status: "countdown",
    userId: "owner-uid",
    triggeredAt: new Date("2025-01-01T12:00:00Z"),
    createdAt: new Date("2025-01-01T12:00:00Z"),
    activatedAt: null,
    cancelledAt: null,
  };

  const docData = { ...defaultData, ...(opts.data ?? {}) };

  const db = {
    collection: vi.fn(() => ({
      doc: vi.fn((_id: string) => ({ id: _id })),
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
          update: vi.fn((_ref: unknown, data: Record<string, unknown>) => {
            updates.set("last", data);
          }),
        };

        await fn(tx);
      }
    ),
  } as unknown as import("firebase-admin/firestore").Firestore;

  return { db, updates };
}

const SESSION_ID = "session-abc-123";
const OWNER_UID = "owner-uid";
const OTHER_UID = "intruder-uid";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cancelSOSSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Authentication (4.1)", () => {
    it("rejects unauthenticated request (401)", async () => {
      const { db } = makeDb();
      const err = await runCancelSOSSession(SESSION_ID, "", db).catch((e) => e);
      expect(err.code).toBe("UNAUTHENTICATED");
      // No Firestore read attempted — auth check is pre-transaction
      expect((db.runTransaction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });
  });

  describe("Ownership (4.2)", () => {
    it("rejects caller who does not own the session (403)", async () => {
      const { db, updates } = makeDb({ data: { userId: OWNER_UID } });
      const err = await runCancelSOSSession(SESSION_ID, OTHER_UID, db).catch((e) => e);
      expect(err.code).toBe("PERMISSION_DENIED");
      // No write attempted
      expect(updates.size).toBe(0);
    });
  });

  describe("countdown → cancelled transition (4.3)", () => {
    it("transitions countdown → cancelled and records cancelledAt", async () => {
      const { db, updates } = makeDb();
      const serverTime = new Date("2025-01-01T12:00:05Z");

      const res = await runCancelSOSSession(SESSION_ID, OWNER_UID, db, serverTime);

      expect(res.cancelled).toBe(true);
      expect(res.alreadyWas).toBe(false);

      const written = updates.get("last")!;
      expect(written["status"]).toBe("cancelled");
      expect(written["cancelledAt"]).toBeInstanceOf(Date);
      expect((written["cancelledAt"] as Date).getTime()).toBe(serverTime.getTime());
      expect(written["updatedAt"]).toBeInstanceOf(Date);
    });

    it("cancelledAt is a native Date, not a Firestore Timestamp (no .seconds/.nanoseconds)", async () => {
      const { db, updates } = makeDb();
      await runCancelSOSSession(SESSION_ID, OWNER_UID, db, new Date());

      const written = updates.get("last")!;
      expect(written["cancelledAt"]).toBeInstanceOf(Date);
      expect((written["cancelledAt"] as any).seconds).toBeUndefined();
      expect((written["cancelledAt"] as any).nanoseconds).toBeUndefined();
    });

    it("writes status, cancelledAt, and updatedAt in a single tx.update call (atomic, no split-write gap)", async () => {
      const { db, updates } = makeDb();
      await runCancelSOSSession(SESSION_ID, OWNER_UID, db, new Date());

      const written = updates.get("last")!;
      // All three fields in one update call — no intermediate state possible
      expect(Object.keys(written)).toEqual(
        expect.arrayContaining(["status", "cancelledAt", "updatedAt"])
      );
    });
  });

  describe("Idempotent re-cancel (P26 variant)", () => {
    it("returns { cancelled: true, alreadyWas: true } when session is already cancelled", async () => {
      const { db, updates } = makeDb({
        data: { status: "cancelled", cancelledAt: new Date("2025-01-01T12:00:05Z") },
      });

      const res = await runCancelSOSSession(SESSION_ID, OWNER_UID, db);

      expect(res.cancelled).toBe(true);
      expect(res.alreadyWas).toBe(true);

      // cancelled is terminal — no write attempted on re-cancel
      expect(updates.size).toBe(0);

      expect(functions.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/idempotent re-cancel/),
        })
      );
    });

    it("cancelled state is terminal — no tx.update is called on re-cancel path", async () => {
      const { db, updates } = makeDb({
        data: { status: "cancelled", cancelledAt: new Date() },
      });

      await runCancelSOSSession(SESSION_ID, OWNER_UID, db);

      // Explicitly confirm no update was written
      expect(updates.size).toBe(0);
    });
  });

  describe("Already-active rejection (P26)", () => {
    it("throws ALREADY_ESCALATED (409) when session is already active", async () => {
      const { db, updates } = makeDb({
        data: { status: "active", activatedAt: new Date() },
      });

      const err = await runCancelSOSSession(SESSION_ID, OWNER_UID, db).catch((e) => e);

      expect(err.code).toBe("ALREADY_ESCALATED");
      // No write attempted — cancelled state was NOT written
      expect(updates.size).toBe(0);

      expect(functions.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/ALREADY_ESCALATED/),
        })
      );
    });
  });

  describe("Session not found", () => {
    it("throws NOT_FOUND when session document does not exist", async () => {
      const { db } = makeDb({ exists: false });
      const err = await runCancelSOSSession(SESSION_ID, OWNER_UID, db).catch((e) => e);
      expect(err.code).toBe("NOT_FOUND");
    });
  });
});
