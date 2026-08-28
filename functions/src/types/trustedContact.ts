/**
 * TrustedContact — a person designated to receive SOS notifications
 * when no verified guardian is found nearby.
 *
 * Stored in the top-level Firestore collection /trusted_contacts/{contactId}.
 * Scoped to a single user via ownerUserId.
 *
 * The collection is read by onSOSSessionUpdate (Admin SDK, bypasses rules)
 * and managed by the client via the TrustedContactsScreen.
 */
export interface TrustedContact {
  /** Firestore document ID — UUID generated client-side. */
  id: string;
  /** Firebase Auth UID of the owner. Used as scope key for all queries. */
  ownerUserId: string;
  /** Display name of the contact. Required, 1–50 chars. */
  name: string;
  /** Phone number. Required, 7–15 chars. */
  phoneNumber: string;
  /** Relationship to the owner (e.g. "sister", "friend"). Optional. */
  relationship: string;
  /** 1-based priority for notification ordering. Lower = notified first. */
  priority: number;
  /** Whether to notify this contact when an SOS session activates. */
  notifyOnSOS: boolean;
  /** Whether to notify on digital threat detection. Not yet implemented. */
  notifyOnDigitalThreat: boolean;
  /** Creation timestamp. NEVER Firestore Timestamp — always native Date. */
  createdAt: Date;
  /** Last-updated timestamp. NEVER Firestore Timestamp — always native Date. */
  updatedAt: Date;
}
