/**
 * onSOSSessionUpdate — Firestore database trigger.
 *
 * Runs proximity matching when an SOS session transitions from 'countdown' to 'active'.
 * Finds nearby verified, on-duty guardians in concentric search rings (1km -> 2km -> 5km -> 10km)
 * and dispatches pings. If no guardians are found, falls back to the user's priority contacts.
 *
 * Uses deterministic document IDs and conditional creates to ensure dispatch is fully idempotent
 * and resumable in case of retries.
 *
 * Requirements: Technical Design — Hyperlocal Guardian Network
 */
import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { deserializeFirestoreDate } from "../utils/assertDate.js";
import type { SOSSession } from "../types/sosSession.js";
import type { Guardian, GuardianPing } from "../types/guardian.js";

/**
 * Calculates the geodetic distance between two coordinates using the Haversine formula.
 */
export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Core business logic for matching guardians or falling back to trusted contacts.
 */
export async function runOnSOSSessionUpdate(
  change: functions.Change<QueryDocumentSnapshot>,
  db: Firestore
): Promise<void> {
  const beforeData = change.before.data() as SOSSession | undefined;
  const afterData = change.after.data() as SOSSession | undefined;

  if (!beforeData || !afterData) {
    return;
  }

  // Step 1 — Verify state transition filter: status: countdown -> active
  if (beforeData.status !== "countdown" || afterData.status !== "active") {
    return;
  }

  const sessionId = afterData.sessionId;
  const userId = afterData.userId;
  const sessionRef = db.collection("sosSessions").doc(sessionId);

  // Validate timestamps
  if (afterData.triggeredAt) {
    deserializeFirestoreDate(afterData.triggeredAt, "triggeredAt");
  }
  if (afterData.createdAt) {
    deserializeFirestoreDate(afterData.createdAt, "createdAt");
  }

  // Step 2 — Extract victim's location
  const location = afterData.location;
  const currentLoc = location?.current;

  let pingedIds: string[] = [];

  if (
    currentLoc &&
    typeof currentLoc.latitude === "number" &&
    typeof currentLoc.longitude === "number"
  ) {
    // Query verified and on-duty guardians
    const guardiansSnap = await db
      .collection("guardians")
      .where("verificationStatus", "==", "verified")
      .where("onDuty", "==", true)
      .get();

    const candidates: { guardian: Guardian; distance: number }[] = [];

    for (const doc of guardiansSnap.docs) {
      const guardian = doc.data() as Guardian;

      // Exclude victim themselves to prevent self-pinging
      if (guardian.guardianId === userId) {
        continue;
      }

      if (
        guardian.currentLocation &&
        typeof guardian.currentLocation.latitude === "number" &&
        typeof guardian.currentLocation.longitude === "number"
      ) {
        const distance = calculateDistanceMeters(
          currentLoc.latitude,
          currentLoc.longitude,
          guardian.currentLocation.latitude,
          guardian.currentLocation.longitude
        );
        candidates.push({ guardian, distance });
      }
    }

    // Filter by concentric expanding steps: 1km -> 2km -> 5km -> 10km
    const radii = [1000, 2000, 5000, 10000];
    let matchedCandidates: { guardian: Guardian; distance: number }[] = [];

    for (const radius of radii) {
      matchedCandidates = candidates.filter((c) => c.distance <= radius);
      if (matchedCandidates.length >= 3) {
        break; // Found at least 3 verified responders; stop expansion
      }
    }

    if (matchedCandidates.length > 0) {
      const sentAt = new Date();

      // Step 3 — Deterministic dispatch with conditional writes
      for (const match of matchedCandidates) {
        const guardianId = match.guardian.guardianId;
        const pingId = `${sessionId}_${guardianId}`;
        const pingRef = db.collection("guardian_pings").doc(pingId);

        const pingData: GuardianPing = {
          pingId,
          sosSessionId: sessionId,
          guardianId,
          sentAt,
          respondedAt: null,
          response: "no_response",
          distanceAtPingMeters: Math.round(match.distance),
        };

        try {
          await pingRef.create(pingData);
          pingedIds.push(guardianId);
        } catch (e: any) {
          // Grpc status code 6 represents ALREADY_EXISTS, or code string check
          if (e.code === 6 || e.code === "already-exists") {
            pingedIds.push(guardianId);
          } else {
            throw e;
          }
        }
      }
    }
  }

  // Step 4 — Record dispatched pings OR execute fallback path
  if (pingedIds.length > 0) {
    // Read-spread-write transaction to append guardiansPinged safely without arrayUnion
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(sessionRef);
      if (!doc.exists) return;
      const data = doc.data() as SOSSession;
      const currentPinged = data.guardiansPinged ?? [];
      const merged = Array.from(new Set([...currentPinged, ...pingedIds]));
      tx.update(sessionRef, { guardiansPinged: merged });
    });
  } else {
    // Fallback: notify priority/trusted contacts
    const contactsSnap = await db
      .collection("trusted_contacts")
      .where("ownerUserId", "==", userId)
      .where("notifyOnSOS", "==", true)
      .get();

    const contactIds = contactsSnap.docs.map((doc) => doc.id);

    if (contactIds.length > 0) {
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(sessionRef);
        if (!doc.exists) return;
        const data = doc.data() as SOSSession;
        const currentNotified = data.contactsNotified ?? [];
        const merged = Array.from(new Set([...currentNotified, ...contactIds]));
        tx.update(sessionRef, { contactsNotified: merged });
      });
    }
  }
}
