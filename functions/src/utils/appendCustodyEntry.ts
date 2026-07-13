/**
 * appendCustodyEntry — THE ONLY permitted path for chain-of-custody writes.
 *
 * Every Cloud Function that needs to append a ChainOfCustodyEntry MUST call
 * this helper inside a Firestore transaction. Direct array mutations and
 * FieldValue.arrayUnion() are EXPLICITLY PROHIBITED throughout the codebase.
 *
 * WHY NOT FieldValue.arrayUnion()?
 * arrayUnion() performs deep structural equality to deduplicate elements.
 * When a ChainOfCustodyEntry contains a `timestamp` field holding a native
 * Date object, Firestore's equality check may silently discard entries whose
 * Date values compare as equal — causing undetectable data loss in the
 * audit log. The read-spread-write pattern below is immune to this because
 * it never asks Firestore to deduplicate anything.
 *
 * USAGE PATTERN (inside a db.runTransaction call):
 *
 *   await db.runTransaction(async (tx) => {
 *     const entry: ChainOfCustodyEntry = {
 *       action: 'uploaded',
 *       performedBy: 'cloud_function',
 *       timestamp: new Date(),      // ← always new Date(), never Timestamp
 *       evidenceId,
 *       metadata: { sha256Hash },
 *       integritySnapshot: computeIntegritySnapshot(docData),
 *     };
 *     await appendCustodyEntry(tx, ref, entry);
 *     // ... other tx.update() calls in the same transaction
 *   });
 *
 * NOTE: appendCustodyEntry calls tx.update() internally. The caller's
 * transaction can include additional update() calls (e.g. status transitions)
 * in the same transaction boundary. All writes in the transaction commit
 * atomically — if any fails, none commit (Req 5.5, Atomicity Guarantee).
 *
 * Requirements: 5.3, 5.4, 5.7, 10.1, 10.2
 * Design: §Chain-of-Custody Append Protocol — Mandatory Transaction Pattern
 * Property 9: Chain-of-Custody Monotonicity
 * Property 10: Custody Entry Completeness
 */
import type { DocumentReference, Transaction } from "firebase-admin/firestore";
import type { ChainOfCustodyEntry } from "../types/evidence.js";

/**
 * Appends a single ChainOfCustodyEntry to the chainOfCustody array of an
 * evidence document, using the mandatory read-spread-write pattern inside
 * the provided Firestore transaction.
 *
 * Also updates `updatedAt` to `new Date()` in the same write, keeping the
 * staleness clock fresh for the 300-second resume threshold.
 *
 * @param tx    - Active Firestore transaction from db.runTransaction().
 * @param ref   - DocumentReference to the /evidence/{evidenceId} document.
 * @param entry - The ChainOfCustodyEntry to append. entry.timestamp MUST
 *                be a native Date set by the caller (e.g. new Date()).
 * @throws TypeError if entry.timestamp is not a Date instance.
 * @throws Error if the document does not exist at read time.
 */
export async function appendCustodyEntry(
  tx: Transaction,
  ref: DocumentReference,
  entry: ChainOfCustodyEntry
): Promise<void> {
  // Validate entry.timestamp before touching Firestore — fail loudly rather
  // than persisting a Firestore Timestamp or null into the audit log.
  if (!(entry.timestamp instanceof Date)) {
    throw new TypeError(
      `appendCustodyEntry: entry.timestamp must be a native Date ` +
        `(got ${entry.timestamp === null ? "null" : typeof entry.timestamp}). ` +
        `Use 'timestamp: new Date()' — never Timestamp.now() or Timestamp.fromDate().`
    );
  }
  if (isNaN(entry.timestamp.getTime())) {
    throw new TypeError(
      `appendCustodyEntry: entry.timestamp is an Invalid Date`
    );
  }

  // Read the current document state within the transaction.
  const snap = await tx.get(ref);
  if (!snap.exists) {
    throw new Error(
      `appendCustodyEntry: document ${ref.path} does not exist`
    );
  }

  const data = snap.data() as { chainOfCustody?: ChainOfCustodyEntry[] };
  const current: ChainOfCustodyEntry[] = data.chainOfCustody ?? [];

  // Read-spread-write: append the new entry to a rebuilt array, then write.
  // FieldValue.arrayUnion() is NEVER used here or anywhere in this codebase.
  tx.update(ref, {
    chainOfCustody: [...current, entry],
    updatedAt: new Date(),
  });
}
