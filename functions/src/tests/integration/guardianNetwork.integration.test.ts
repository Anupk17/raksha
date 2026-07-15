/**
 * Hyperlocal Guardian Network Integration Tests
 *
 * Runs against the Firebase Emulator Suite (Firestore on localhost:8080).
 * Verifies proximity matching, deterministic dispatch, fallback contacts,
 * callable response updates, and security rules.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getTestEnv,
  getAdminFirestore,
  clearFirestore,
  cleanupTestEnv,
} from "./helpers.js";
import { runOnSOSSessionUpdate } from "../../functions/onSOSSessionUpdate.js";
import { runRespondToGuardianPing } from "../../functions/respondToGuardianPing.js";

const VICTIM_ID = "victim-user-1";
const GUARDIAN_1 = "guardian-user-1";
const GUARDIAN_2 = "guardian-user-2";
const GUARDIAN_3 = "guardian-user-3";
const GUARDIAN_4 = "guardian-user-4";

function makeChangeMock(beforeSnap: any, afterSnap: any): any {
  return {
    before: beforeSnap,
    after: afterSnap,
  };
}

describe("Hyperlocal Guardian Network Integration Tests", () => {
  beforeAll(async () => {
    await getTestEnv();
  });

  afterAll(async () => {
    await cleanupTestEnv();
  });

  beforeEach(async () => {
    await clearFirestore();
  });

  // =========================================================================
  // Test 1: Happy Path Dispatch
  // =========================================================================
  it("performs happy path dispatch to 3 nearby guardians and updates guardiansPinged", async () => {
    const db = getAdminFirestore();

    // 1. Setup guardians
    const guardians = [GUARDIAN_1, GUARDIAN_2, GUARDIAN_3];
    const coords = [
      { latitude: 10.002, longitude: 10.002 }, // ~314m away
      { latitude: 10.008, longitude: 10.008 }, // ~1.25km away
      { latitude: 10.015, longitude: 10.015 }, // ~2.35km away
    ];

    for (let i = 0; i < guardians.length; i++) {
      await db.collection("guardians").doc(guardians[i]!).set({
        guardianId: guardians[i],
        verificationStatus: "verified",
        onDuty: true,
        currentLocation: coords[i],
        responseStats: { totalPings: 0, respondedCount: 0, avgResponseTimeSeconds: 0 },
      });
    }

    // 2. Setup session
    const sessionId = "session-happy-path";
    const sessionRef = db.collection("sosSessions").doc(sessionId);

    const beforeData = {
      sessionId,
      userId: VICTIM_ID,
      status: "countdown",
      location: {
        latHash: "h1",
        lngHash: "h2",
        current: { latitude: 10.0, longitude: 10.0 },
      },
      triggeredAt: new Date(),
      createdAt: new Date(),
    };

    const afterData = {
      ...beforeData,
      status: "active",
      activatedAt: new Date(),
    };

    await sessionRef.set(beforeData);

    const beforeSnap = await sessionRef.get();
    await sessionRef.set(afterData);
    const afterSnap = await sessionRef.get();

    // 3. Execute trigger
    const change = makeChangeMock(beforeSnap, afterSnap);
    await runOnSOSSessionUpdate(change, db);

    // 4. Assertions
    const finalSessionDoc = await sessionRef.get();
    const finalSession = finalSessionDoc.data();
    expect(finalSession?.["guardiansPinged"]).toEqual(expect.arrayContaining(guardians));

    for (const gId of guardians) {
      const pingDoc = await db.collection("guardian_pings").doc(`${sessionId}_${gId}`).get();
      expect(pingDoc.exists).toBe(true);
      const pingData = pingDoc.data();
      expect(pingData?.["response"]).toBe("no_response");
      expect(pingData?.["distanceAtPingMeters"]).toBeGreaterThan(0);
    }
  });

  // =========================================================================
  // Test 2: Concentric Expansion
  // =========================================================================
  it("stops expansion at 5km when at least 3 verified responders are found", async () => {
    const db = getAdminFirestore();

    // Setup guardians at varying distances: 500m, 1.5km, 4km, 8km
    const guardians = [GUARDIAN_1, GUARDIAN_2, GUARDIAN_3, GUARDIAN_4];
    const coords = [
      { latitude: 10.003, longitude: 10.003 }, // ~471m
      { latitude: 10.012, longitude: 10.012 }, // ~1.88km
      { latitude: 10.032, longitude: 10.032 }, // ~5.01km (let's make it 3km/latitude 10.02 to be within 5km)
      { latitude: 10.07, longitude: 10.07 },   // ~11km
    ];
    // Adjust coords to be exactly within concentric rings:
    // G1 (500m) matches 1km ring
    // G2 (1.8km) matches 2km ring
    // G3 (3.5km) matches 5km ring
    // G4 (11km) is beyond 10km ring
    coords[2] = { latitude: 10.025, longitude: 10.025 }; // ~3.92km
    coords[3] = { latitude: 10.065, longitude: 10.065 }; // ~10.2km

    for (let i = 0; i < guardians.length; i++) {
      await db.collection("guardians").doc(guardians[i]!).set({
        guardianId: guardians[i],
        verificationStatus: "verified",
        onDuty: true,
        currentLocation: coords[i],
        responseStats: { totalPings: 0, respondedCount: 0, avgResponseTimeSeconds: 0 },
      });
    }

    const sessionId = "session-concentric";
    const sessionRef = db.collection("sosSessions").doc(sessionId);

    const beforeData = {
      sessionId,
      userId: VICTIM_ID,
      status: "countdown",
      location: {
        latHash: "h1",
        lngHash: "h2",
        current: { latitude: 10.0, longitude: 10.0 },
      },
      triggeredAt: new Date(),
      createdAt: new Date(),
    };
    const afterData = { ...beforeData, status: "active", activatedAt: new Date() };

    await sessionRef.set(beforeData);
    const beforeSnap = await sessionRef.get();
    await sessionRef.set(afterData);
    const afterSnap = await sessionRef.get();

    const change = makeChangeMock(beforeSnap, afterSnap);
    await runOnSOSSessionUpdate(change, db);

    const finalSession = (await sessionRef.get()).data();
    // G1, G2, G3 pinged. G4 is not pinged.
    expect(finalSession?.["guardiansPinged"]).toContain(GUARDIAN_1);
    expect(finalSession?.["guardiansPinged"]).toContain(GUARDIAN_2);
    expect(finalSession?.["guardiansPinged"]).toContain(GUARDIAN_3);
    expect(finalSession?.["guardiansPinged"]).not.toContain(GUARDIAN_4);
  });

  // =========================================================================
  // Test 3: Resumable Dispatch
  // =========================================================================
  it("absorbs duplicate ping attempts idempotently if trigger is re-run", async () => {
    const db = getAdminFirestore();

    await db.collection("guardians").doc(GUARDIAN_1).set({
      guardianId: GUARDIAN_1,
      verificationStatus: "verified",
      onDuty: true,
      currentLocation: { latitude: 10.001, longitude: 10.001 },
    });

    const sessionId = "session-resumable";
    const sessionRef = db.collection("sosSessions").doc(sessionId);
    const beforeData = {
      sessionId,
      userId: VICTIM_ID,
      status: "countdown",
      location: {
        latHash: "h1",
        lngHash: "h2",
        current: { latitude: 10.0, longitude: 10.0 },
      },
      triggeredAt: new Date(),
      createdAt: new Date(),
    };
    const afterData = { ...beforeData, status: "active", activatedAt: new Date() };

    await sessionRef.set(beforeData);
    const beforeSnap = await sessionRef.get();
    await sessionRef.set(afterData);
    const afterSnap = await sessionRef.get();

    const change = makeChangeMock(beforeSnap, afterSnap);

    // Run 1
    await runOnSOSSessionUpdate(change, db);
    // Run 2
    await runOnSOSSessionUpdate(change, db);

    const pingDoc = await db.collection("guardian_pings").doc(`${sessionId}_${GUARDIAN_1}`).get();
    expect(pingDoc.exists).toBe(true);

    const finalSession = (await sessionRef.get()).data();
    expect(finalSession?.["guardiansPinged"]).toContain(GUARDIAN_1);
  });

  // =========================================================================
  // Test 4: Priority Contacts Fallback
  // =========================================================================
  it("falls back to priority contacts when no guardians are within 10km", async () => {
    const db = getAdminFirestore();

    // No guardians registered. Set up trusted contacts.
    await db.collection("trusted_contacts").doc("contact-1").set({
      ownerUserId: VICTIM_ID,
      notifyOnSOS: true,
    });
    await db.collection("trusted_contacts").doc("contact-2").set({
      ownerUserId: VICTIM_ID,
      notifyOnSOS: false,
    });

    const sessionId = "session-fallback";
    const sessionRef = db.collection("sosSessions").doc(sessionId);
    const beforeData = {
      sessionId,
      userId: VICTIM_ID,
      status: "countdown",
      location: {
        latHash: "h1",
        lngHash: "h2",
        current: { latitude: 10.0, longitude: 10.0 },
      },
      triggeredAt: new Date(),
      createdAt: new Date(),
    };
    const afterData = { ...beforeData, status: "active", activatedAt: new Date() };

    await sessionRef.set(beforeData);
    const beforeSnap = await sessionRef.get();
    await sessionRef.set(afterData);
    const afterSnap = await sessionRef.get();

    const change = makeChangeMock(beforeSnap, afterSnap);
    await runOnSOSSessionUpdate(change, db);

    const finalSession = (await sessionRef.get()).data();
    expect(finalSession?.["contactsNotified"]).toContain("contact-1");
    expect(finalSession?.["contactsNotified"]).not.toContain("contact-2");
    expect(finalSession?.["guardiansPinged"]).toBeUndefined();
  });

  // =========================================================================
  // Test 5: Response Stats Update
  // =========================================================================
  it("updates response stats correctly when a guardian responds to a ping", async () => {
    const db = getAdminFirestore();
    const sentAt = new Date(Date.now() - 40 * 1000); // 40 seconds ago

    await db.collection("guardians").doc(GUARDIAN_1).set({
      guardianId: GUARDIAN_1,
      verificationStatus: "verified",
      onDuty: true,
      responseStats: {
        totalPings: 4,
        respondedCount: 2,
        avgResponseTimeSeconds: 15.0,
      },
    });

    const pingId = `session-response-stats_${GUARDIAN_1}`;
    await db.collection("guardian_pings").doc(pingId).set({
      pingId,
      sosSessionId: "session-response-stats",
      guardianId: GUARDIAN_1,
      sentAt,
      respondedAt: null,
      response: "no_response",
    });

    const response = await runRespondToGuardianPing(
      { pingId, response: "accepted" },
      GUARDIAN_1,
      db
    );

    expect(response.success).toBe(true);

    const updatedGuardian = (await db.collection("guardians").doc(GUARDIAN_1).get()).data();
    const stats = updatedGuardian?.["responseStats"];
    expect(stats.totalPings).toBe(5);
    expect(stats.respondedCount).toBe(3);
    // responseTime = 40. oldAvg = 15, count = 2.
    // newAvg = 15 + (40 - 15) / 3 = 15 + 25/3 = 15 + 8.333333 = 23.3333
    expect(stats.avgResponseTimeSeconds).toBeCloseTo(23.33, 1);
  });

  // =========================================================================
  // Test 6: Security Rules
  // =========================================================================
  describe("Security Rules Verification", () => {
    it("allows a guardian to read and write their own profile, but denies others", async () => {
      const db = getAdminFirestore();

      // Create profile via Admin SDK
      await db.collection("guardians").doc(GUARDIAN_1).set({
        guardianId: GUARDIAN_1,
        onDuty: true,
      });

      const testEnv = await getTestEnv();

      // Owner client
      const ownerDb = testEnv.authenticatedContext(GUARDIAN_1).firestore();
      const snapOwner = await ownerDb.collection("guardians").doc(GUARDIAN_1).get();
      expect(snapOwner.exists).toBe(true);

      await ownerDb.collection("guardians").doc(GUARDIAN_1).update({ onDuty: false });
      const snapOwnerUpdated = await db.collection("guardians").doc(GUARDIAN_1).get();
      expect(snapOwnerUpdated.data()?.["onDuty"]).toBe(false);

      // Stranger client
      const strangerDb = testEnv.authenticatedContext(GUARDIAN_2).firestore();
      await expect(
        strangerDb.collection("guardians").doc(GUARDIAN_1).get()
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|false for/i);

      await expect(
        strangerDb.collection("guardians").doc(GUARDIAN_1).update({ onDuty: true })
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|false for/i);
    });

    it("allows the assigned guardian to read their pings, but denies others and denies client writes", async () => {
      const db = getAdminFirestore();
      const pingId = `session-sec_${GUARDIAN_1}`;

      await db.collection("guardian_pings").doc(pingId).set({
        pingId,
        guardianId: GUARDIAN_1,
        response: "no_response",
      });

      const testEnv = await getTestEnv();

      // Assigned guardian reads
      const guardianDb = testEnv.authenticatedContext(GUARDIAN_1).firestore();
      const snapPing = await guardianDb.collection("guardian_pings").doc(pingId).get();
      expect(snapPing.exists).toBe(true);

      // Deny update on pings to clients
      await expect(
        guardianDb.collection("guardian_pings").doc(pingId).update({ response: "accepted" })
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|false for/i);

      // Stranger client reads
      const strangerDb = testEnv.authenticatedContext(GUARDIAN_2).firestore();
      await expect(
        strangerDb.collection("guardian_pings").doc(pingId).get()
      ).rejects.toThrow(/PERMISSION_DENIED|permission-denied|false for/i);
    });
  });
});
