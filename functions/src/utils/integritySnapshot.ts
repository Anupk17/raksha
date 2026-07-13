/**
 * Deterministic integrity snapshot for chain-of-custody entries.
 *
 * Each time a ChainOfCustodyEntry is appended, the Cloud Function computes
 * a SHA-256 digest over the evidence document's immutable fields and stores
 * it as integritySnapshot on the entry. This lets anyone verify that the
 * immutable fields have not changed since that entry was recorded.
 *
 * Determinism requirements:
 *   - Fields are always serialized in the same lexicographic key order
 *     (enforced by the object literal below — V8 preserves insertion order
 *     for non-integer string keys)
 *   - createdAt is serialized as ISO 8601 (toISOString()) — a stable,
 *     timezone-independent format
 *   - No optional chaining or defaulting: if a required field is missing,
 *     the function throws rather than silently producing a hash of partial data
 *
 * Immutable fields (lexicographic order):
 *   createdAt, evidenceId, incidentId, mimeType, originalFilename,
 *   sha256Hash, sizeBytes, userId
 *
 * Requirements: 3.3
 * Design: §Chain-of-Custody Append Protocol — integritySnapshot Computation
 * Property 7: integritySnapshot is Deterministic
 */
import crypto from "crypto";
import type { EvidenceDocument } from "../types/evidence.js";

/**
 * Computes a SHA-256 hex digest over the deterministic JSON serialization
 * of the evidence document's 8 immutable fields.
 *
 * @param doc - The EvidenceDocument (or partial) to snapshot. All 8 immutable
 *              fields must be present and non-null.
 * @returns 64-character lowercase hex SHA-256 digest.
 * @throws TypeError if any required immutable field is missing or null.
 */
export function computeIntegritySnapshot(
  doc: Pick<
    EvidenceDocument,
    | "createdAt"
    | "evidenceId"
    | "incidentId"
    | "mimeType"
    | "originalFilename"
    | "sha256Hash"
    | "sizeBytes"
    | "userId"
  >
): string {
  // Validate all required fields are present before hashing. A partial hash
  // would be worse than no hash — it would look valid but cover incomplete data.
  const required: Array<keyof typeof doc> = [
    "createdAt",
    "evidenceId",
    "incidentId",
    "mimeType",
    "originalFilename",
    "sha256Hash",
    "sizeBytes",
    "userId",
  ];
  for (const field of required) {
    if (doc[field] === null || doc[field] === undefined) {
      throw new TypeError(
        `computeIntegritySnapshot: required field '${field}' is ${doc[field]}`
      );
    }
  }
  if (!(doc.createdAt instanceof Date)) {
    throw new TypeError(
      `computeIntegritySnapshot: 'createdAt' must be a Date ` +
        `(got ${typeof doc.createdAt})`
    );
  }

  // Keys in lexicographic order — must match exactly across all environments.
  const snapshot = {
    createdAt: doc.createdAt.toISOString(),
    evidenceId: doc.evidenceId,
    incidentId: doc.incidentId,
    mimeType: doc.mimeType,
    originalFilename: doc.originalFilename,
    sha256Hash: doc.sha256Hash,
    sizeBytes: doc.sizeBytes,
    userId: doc.userId,
  };

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
}
