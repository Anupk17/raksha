/**
 * Tests for core evidence types.
 *
 * These are largely compile-time checks expressed as runtime assertions.
 * The main guarantee is that the shape is correct and that every timestamp
 * field is typed as Date (never Timestamp).
 *
 * Feature: evidence-trail, Task 1.1: Core TypeScript interfaces
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type {
  EvidenceDocument,
  ChainOfCustodyEntry,
  EvidenceStatus,
  CustodyAction,
  GrantedContact,
} from "./evidence.js";

// ---------------------------------------------------------------------------
// Valid sets (used across tests)
// ---------------------------------------------------------------------------

const VALID_STATUSES: EvidenceStatus[] = [
  "uploading",
  "processing",
  "available",
  "expired",
  "legal_hold",
  "failed",
  "integrity_failed",
  "encryption_failed",
];

const VALID_ACTIONS: CustodyAction[] = [
  "uploaded",
  "viewed",
  "shared",
  "exported",
  "legal_hold_set",
  "legal_hold_released",
  "status_changed",
  "granted",
  "revoked",
];

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbDate = fc.date({ min: new Date("2020-01-01"), max: new Date("2099-12-31") });

const arbCustodyAction = fc.constantFrom(...VALID_ACTIONS);
const arbEvidenceStatus = fc.constantFrom(...VALID_STATUSES);

const arbCustodyEntry = fc.record<ChainOfCustodyEntry>({
  action: arbCustodyAction,
  performedBy: fc.oneof(
    fc.constant("cloud_function"),
    fc.constant("system"),
    fc.string({ minLength: 1, maxLength: 64 })
  ),
  timestamp: arbDate,
  evidenceId: fc.string({ minLength: 1, maxLength: 64 }),
  metadata: fc.option(
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 32 }),
      fc.string({ minLength: 0, maxLength: 256 })
    ),
    { nil: null }
  ),
  integritySnapshot: fc.option(
    fc.hexaString({ minLength: 64, maxLength: 64 }),
    { nil: null }
  ),
});

const arbEvidenceDocument = fc.record<EvidenceDocument>({
  evidenceId: fc.string({ minLength: 1, maxLength: 64 }),
  incidentId: fc.string({ minLength: 1, maxLength: 64 }),
  userId: fc.string({ minLength: 1, maxLength: 64 }),
  type: fc.constantFrom("photo", "video", "audio", "screenshot", "document"),
  storageRef: fc.string({ minLength: 1, maxLength: 256 }),
  originalFilename: fc.string({ minLength: 1, maxLength: 256 }),
  mimeType: fc.string({ minLength: 1, maxLength: 64 }),
  sizeBytes: fc.integer({ min: 1, max: 100_000_000 }),
  sha256Hash: fc.hexaString({ minLength: 64, maxLength: 64 }),
  encryptionKeyRef: fc.string({ minLength: 0, maxLength: 256 }),
  encryptionIV: fc.string({ minLength: 0, maxLength: 24 }),
  status: arbEvidenceStatus,
  retentionExpiresAt: fc.option(arbDate, { nil: null }),
  legalHoldReason: fc.option(
    fc.string({ minLength: 1, maxLength: 1000 }),
    { nil: null }
  ),
  chainOfCustody: fc.array(arbCustodyEntry, { minLength: 0, maxLength: 10 }),
  createdAt: arbDate,
  updatedAt: arbDate,
  metadata: fc.record({
    capturedAt: arbDate,
    deviceInfo: fc.string({ minLength: 0, maxLength: 256 }),
    locationHash: fc.option(
      fc.hexaString({ minLength: 64, maxLength: 64 }),
      { nil: null }
    ),
    incidentContext: fc.option(fc.string({ maxLength: 1000 }), { nil: null }),
  }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvidenceStatus type", () => {
  it("contains exactly 8 valid values", () => {
    expect(VALID_STATUSES).toHaveLength(8);
  });

  it("includes all required terminal states", () => {
    expect(VALID_STATUSES).toContain("failed");
    expect(VALID_STATUSES).toContain("integrity_failed");
    expect(VALID_STATUSES).toContain("encryption_failed");
  });
});

describe("CustodyAction type", () => {
  it("contains exactly 9 action values", () => {
    expect(VALID_ACTIONS).toHaveLength(9);
  });

  it("includes distinct granted and revoked (not just shared)", () => {
    expect(VALID_ACTIONS).toContain("granted");
    expect(VALID_ACTIONS).toContain("revoked");
  });
});

describe("EvidenceDocument shape (Property P3: all required fields present)", () => {
  it(
    "P3: any generated EvidenceDocument has all required fields non-null",
    () => {
      // Feature: evidence-trail, Property 3: All Required Fields Present at Creation
      fc.assert(
        fc.property(arbEvidenceDocument, (doc) => {
          // Required non-nullable fields
          expect(doc.evidenceId).toBeTruthy();
          expect(doc.incidentId).toBeTruthy();
          expect(doc.userId).toBeTruthy();
          expect(doc.type).toBeTruthy();
          expect(doc.storageRef).toBeTruthy();
          expect(doc.originalFilename).toBeTruthy();
          expect(doc.mimeType).toBeTruthy();
          expect(doc.sizeBytes).toBeGreaterThan(0);
          expect(doc.sha256Hash).toBeTruthy();
          expect(doc.status).toBeTruthy();
          expect(doc.chainOfCustody).toBeInstanceOf(Array);
          expect(doc.metadata).toBeTruthy();
          expect(doc.metadata.capturedAt).toBeInstanceOf(Date);

          // Timestamp fields must be Date instances
          expect(doc.createdAt).toBeInstanceOf(Date);
          expect(doc.updatedAt).toBeInstanceOf(Date);
          expect(doc.metadata.capturedAt).toBeInstanceOf(Date);
          if (doc.retentionExpiresAt !== null) {
            expect(doc.retentionExpiresAt).toBeInstanceOf(Date);
          }
        }),
        { numRuns: 100 }
      );
    }
  );
});

describe("ChainOfCustodyEntry shape", () => {
  it(
    "every generated entry has all required fields with correct types",
    () => {
      // Feature: evidence-trail, Property 10: Custody Entry Completeness
      fc.assert(
        fc.property(arbCustodyEntry, (entry) => {
          expect(entry.action).toBeTruthy();
          expect(entry.performedBy).toBeTruthy();
          // CRITICAL: timestamp must be native Date, never Firestore Timestamp
          expect(entry.timestamp).toBeInstanceOf(Date);
          expect(entry.evidenceId).toBeTruthy();
        }),
        { numRuns: 100 }
      );
    }
  );
});

describe("GrantedContact shape", () => {
  it("grantedAt is a Date", () => {
    fc.assert(
      fc.property(
        fc.record<GrantedContact>({
          contactUid: fc.string({ minLength: 1, maxLength: 64 }),
          ownerId: fc.string({ minLength: 1, maxLength: 64 }),
          grantedAt: arbDate,
          revoked: fc.boolean(),
          revokedAt: fc.option(arbDate, { nil: null }),
        }),
        (contact) => {
          expect(contact.grantedAt).toBeInstanceOf(Date);
          if (contact.revokedAt !== null) {
            expect(contact.revokedAt).toBeInstanceOf(Date);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
