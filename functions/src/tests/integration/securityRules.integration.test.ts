/**
 * Task 6 — Firestore Security Rules Integration Tests
 *
 * Runs against the real Firebase Emulator Suite.
 * Verifies security rules for:
 *   - /sosSessions/{sessionId} (owner read only, no client writes allowed)
 *   - /users/{userId} (owner read/write only)
 *
 * Requirements: tasks.md Task 6
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getTestEnv,
  getAdminFirestore,
  clearFirestore,
} from "./helpers.js";

describe("Task 6: Firestore Security Rules integration tests", () => {
  beforeAll(async () => {
    await getTestEnv();
  });

  afterAll(async () => {
    const { cleanupTestEnv } = await import("./helpers.js");
    await cleanupTestEnv();
  });

  beforeEach(async () => {
    await clearFirestore();
  });

  describe("/sosSessions/{sessionId}", () => {
    const sessionId = "session-123";
    const ownerUid = "owner-user";
    const strangerUid = "stranger-user";

    // Setup an existing document using Admin SDK (bypasses rules)
    async function setupSessionDoc() {
      const adminDb = getAdminFirestore();
      await adminDb.collection("sosSessions").doc(sessionId).set({
        sessionId,
        userId: ownerUid,
        status: "countdown",
        triggeredAt: new Date(),
        createdAt: new Date(),
        cancelledAt: null,
        activatedAt: null,
      });
    }

    it("allows the owner to read their own session document", async () => {
      await setupSessionDoc();

      const testEnv = await getTestEnv();
      const ownerCtx = testEnv.authenticatedContext(ownerUid);
      const ownerDb = ownerCtx.firestore();

      const snap = await ownerDb.collection("sosSessions").doc(sessionId).get();
      expect(snap.exists).toBe(true);
      expect(snap.data()?.["userId"]).toBe(ownerUid);
    });

    it("denies access to a non-owner attempting to read the session document", async () => {
      await setupSessionDoc();

      const testEnv = await getTestEnv();
      const strangerCtx = testEnv.authenticatedContext(strangerUid);
      const strangerDb = strangerCtx.firestore();

      await expect(
        strangerDb.collection("sosSessions").doc(sessionId).get()
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);
    });

    it("denies access to unauthenticated client attempting to read the session document", async () => {
      await setupSessionDoc();

      const testEnv = await getTestEnv();
      const anonCtx = testEnv.unauthenticatedContext();
      const anonDb = anonCtx.firestore();

      await expect(
        anonDb.collection("sosSessions").doc(sessionId).get()
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);
    });

    it("denies client attempts to create a session document", async () => {
      const testEnv = await getTestEnv();
      const ownerCtx = testEnv.authenticatedContext(ownerUid);
      const ownerDb = ownerCtx.firestore();

      await expect(
        ownerDb.collection("sosSessions").doc(sessionId).set({
          sessionId,
          userId: ownerUid,
          status: "countdown",
        })
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);
    });

    it("denies client attempts to update a session document", async () => {
      await setupSessionDoc();

      const testEnv = await getTestEnv();
      const ownerCtx = testEnv.authenticatedContext(ownerUid);
      const ownerDb = ownerCtx.firestore();

      await expect(
        ownerDb.collection("sosSessions").doc(sessionId).update({
          status: "cancelled",
        })
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);
    });

    it("denies client attempts to delete a session document", async () => {
      await setupSessionDoc();

      const testEnv = await getTestEnv();
      const ownerCtx = testEnv.authenticatedContext(ownerUid);
      const ownerDb = ownerCtx.firestore();

      await expect(
        ownerDb.collection("sosSessions").doc(sessionId).delete()
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);
    });
  });

  describe("/users/{userId}", () => {
    const ownerUid = "owner-user";
    const strangerUid = "stranger-user";

    it("allows the owner to read and write their own user document with a valid bcrypt cost=10 hash", async () => {
      const testEnv = await getTestEnv();
      const ownerCtx = testEnv.authenticatedContext(ownerUid);
      const ownerDb = ownerCtx.firestore();

      const userDocRef = ownerDb.collection("users").doc(ownerUid);

      // Write config with a valid bcrypt cost=10 hash
      await expect(
        userDocRef.set({
          userId: ownerUid,
          silentActivationConfig: {
            duressPinHash: "$2b$10$12345678901234567890123456789012345678901234567890123",
            configuredTapCount: 5,
          },
        })
      ).resolves.not.toThrow();

      // Read back config
      const snap = await userDocRef.get();
      expect(snap.exists).toBe(true);
      expect(snap.data()?.["userId"]).toBe(ownerUid);
    });

    it("denies the owner from writing a plaintext PIN to duressPinHash", async () => {
      const testEnv = await getTestEnv();
      const ownerCtx = testEnv.authenticatedContext(ownerUid);
      const ownerDb = ownerCtx.firestore();

      const userDocRef = ownerDb.collection("users").doc(ownerUid);

      // Try write with plaintext PIN
      await expect(
        userDocRef.set({
          userId: ownerUid,
          silentActivationConfig: {
            duressPinHash: "123456", // plaintext
            configuredTapCount: 5,
          },
        })
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);
    });

    it("denies the owner from writing a bcrypt hash with cost=8", async () => {
      const testEnv = await getTestEnv();
      const ownerCtx = testEnv.authenticatedContext(ownerUid);
      const ownerDb = ownerCtx.firestore();

      const userDocRef = ownerDb.collection("users").doc(ownerUid);

      // Try write with cost=8 bcrypt hash
      await expect(
        userDocRef.set({
          userId: ownerUid,
          silentActivationConfig: {
            duressPinHash: "$2b$08$12345678901234567890123456789012345678901234567890123", // cost=8
            configuredTapCount: 5,
          },
        })
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);
    });

    it("denies a non-owner from reading or writing another user's document", async () => {
      const testEnv = await getTestEnv();
      const strangerCtx = testEnv.authenticatedContext(strangerUid);
      const strangerDb = strangerCtx.firestore();

      const userDocRef = strangerDb.collection("users").doc(ownerUid);

      // Try write
      await expect(
        userDocRef.set({
          userId: ownerUid,
          silentActivationConfig: { duressPinHash: "evil" },
        })
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);

      // Try read
      await expect(userDocRef.get()).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);
    });

    it("denies unauthenticated client from reading or writing any user document", async () => {
      const testEnv = await getTestEnv();
      const anonCtx = testEnv.unauthenticatedContext();
      const anonDb = anonCtx.firestore();

      const userDocRef = anonDb.collection("users").doc(ownerUid);

      // Try write
      await expect(
        userDocRef.set({
          userId: ownerUid,
          silentActivationConfig: { duressPinHash: "evil" },
        })
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);

      // Try read
      await expect(userDocRef.get()).rejects.toThrow(/PERMISSION_DENIED|permission-denied|evaluation error|false for/i);
    });
  });
});
