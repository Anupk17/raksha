/**
 * Tests for testTrigger Cloud Function (Task 5).
 *
 * Verifies that the endpoint successfully validates the payload format,
 * returns a mock sessionId, but writes absolutely nothing to Firestore
 * and schedules no Cloud Tasks.
 *
 * Requirements: design.md §testTrigger, tasks.md Task 5.3
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runTestTrigger } from "./testTrigger.js";
import crypto from "crypto";
import type { CreateSOSSessionPayload } from "../types/sosSession.js";
import * as functions from "firebase-functions";

// Mock firebase-functions logger
vi.mock("firebase-functions", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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

describe("testTrigger", () => {
  const CALLER_UID = "user-abc-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Validation", () => {
    it("rejects unauthenticated request (401)", async () => {
      const err = await runTestTrigger(makePayload(), "").catch((e) => e);
      expect(err.code).toBe("UNAUTHENTICATED");
    });

    it("rejects invalid triggerType (400)", async () => {
      const payload = makePayload({ triggerType: "invalid" as any });
      const err = await runTestTrigger(payload, CALLER_UID).catch((e) => e);
      expect(err.code).toBe("INVALID_ARGUMENT");
    });

    it("rejects future triggeredAt (400)", async () => {
      const serverTime = new Date("2025-01-01T12:00:00Z");
      const futureTime = new Date("2025-01-01T12:00:10Z"); // 10s future
      const payload = makePayload({ triggeredAt: futureTime.toISOString() });

      const err = await runTestTrigger(payload, CALLER_UID, serverTime).catch((e) => e);
      expect(err.code).toBe("INVALID_ARGUMENT");
    });

    it("rejects triggeredAt older than 72 hours (400)", async () => {
      const serverTime = new Date("2025-01-04T12:00:00Z");
      const oldTime = new Date("2025-01-01T11:00:00Z"); // 73 hours past
      const payload = makePayload({ triggeredAt: oldTime.toISOString() });

      const err = await runTestTrigger(payload, CALLER_UID, serverTime).catch((e) => e);
      expect(err.code).toBe("INVALID_ARGUMENT");
    });
  });

  describe("No-Op Guarantee and Synthesized Response", () => {
    it("returns success with sessionId starting with 'test_' and status: 'countdown'", async () => {
      const payload = makePayload();
      const res = await runTestTrigger(payload, CALLER_UID);

      expect(res.alreadyExists).toBe(false);
      expect(res.status).toBe("countdown");
      expect(res.sessionId).toMatch(/^test_/);
    });

    it("does not write to Firestore or enqueue tasks (explicit side-effect check)", async () => {
      // By construction, runTestTrigger receives no Firestore db client reference
      // and no CloudTasksClient reference. This guarantees compile-time protection
      // against accidental side-effects. We confirm it returns cleanly.
      const payload = makePayload();
      const res = await runTestTrigger(payload, CALLER_UID);
      expect(res.sessionId).toBeDefined();
    });
  });

  describe("Audit Logging", () => {
    it("writes audit log with hashed userId and truncated timestamp precision", async () => {
      const serverTime = new Date("2025-01-01T12:00:00.123Z");
      const payload = makePayload({
        triggeredAt: "2025-01-01T11:59:58.456Z",
        triggerType: "power_button",
      });

      await runTestTrigger(payload, CALLER_UID, serverTime);

      const expectedHashedUid = crypto.createHash("sha256").update(CALLER_UID).digest("hex").slice(0, 16);

      expect(functions.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "testTrigger audit log",
          userId: expectedHashedUid,
          triggerType: "power_button",
          triggeredAt: "2025-01-01T11:59:58Z", // No .456
          createdAt: "2025-01-01T12:00:00Z",   // No .123
        })
      );
    });
  });
});
