/**
 * TypeScript interfaces for the RAKSHA Hyperlocal Guardian Network.
 *
 * ─── TIMESTAMP RULE ──────────────────────────────────────────────────────────
 * All Date fields in this file use JavaScript's native Date class.
 * Firestore Timestamp is NEVER used.
 * Violations cause deserialization failures at runtime.
 *
 * Use assertDate() / assertDateOrNull() from utils/assertDate.ts to guard
 * every timestamp field when reading from Firestore.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Design: RAKSHA Technical Design — Hyperlocal Guardian Network §guardian.ts
 * Requirements: implementation_plan.md, task.md Task 1
 */

/**
 * Valid verification statuses for a Guardian.
 */
export type GuardianVerificationStatus = "pending" | "verified" | "rejected";

/**
 * Guardian response statistics for gamification and ranking.
 */
export interface ResponseStats {
  totalPings: number;
  respondedCount: number;
  avgResponseTimeSeconds: number;
}

/**
 * Firestore GeoPoint structure representation for TypeScript.
 */
export interface FirestoreGeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * Shape of a document in the `guardians` collection (`guardians/{guardianId}`).
 */
export interface Guardian {
  /** The Firebase Auth UID of the guardian. */
  guardianId: string;
  
  /** Current verification status. Only verified guardians receive pings. */
  verificationStatus: GuardianVerificationStatus;
  
  /** Cloud Storage paths to verification documents. */
  verificationDocs: string[];
  
  /** Response metrics for gamification. */
  responseStats: ResponseStats;
  
  /** Current GPS location of the guardian. Updated only while onDuty is true. */
  currentLocation: FirestoreGeoPoint;
  
  /** Whether the guardian is currently active and accepting alerts. */
  onDuty: boolean;
  
  /**
   * The last time the guardian's location was updated.
   * NEVER Firestore Timestamp.
   */
  lastLocationUpdate: Date;
}

/**
 * Response status choices for a ping.
 * Multiple guardians can simultaneously accept the same ping (convergence).
 */
export type GuardianResponse = "accepted" | "declined" | "no_response";

/**
 * Shape of a document in the `guardian_pings` collection (`guardian_pings/{pingId}`).
 * Document ID is deterministically generated as: `${sosSessionId}_${guardianId}`.
 */
export interface GuardianPing {
  /** Deterministic ID: `${sosSessionId}_${guardianId}` */
  pingId: string;
  
  /** Reference to the active SOSSession. */
  sosSessionId: string;
  
  /** Reference to the pinged Guardian. */
  guardianId: string;
  
  /**
   * Time the ping was dispatched.
   * NEVER Firestore Timestamp.
   */
  sentAt: Date;
  
  /**
   * Time the guardian responded to the ping (null if no response).
   * NEVER Firestore Timestamp.
   */
  respondedAt: Date | null;
  
  /** The response status. */
  response: GuardianResponse;
  
  /** Distance in meters between the victim and the guardian at ping time. */
  distanceAtPingMeters: number;
}
