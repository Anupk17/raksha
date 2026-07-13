/**
 * Tests for validateFile and checkIdempotency (Phase 10, tasks 10.1–10.2).
 *
 * Property 1: File Acceptance Predicate is Consistent
 * Property 5: Staleness Window Branch Selection
 * Requirements: 1.1, 2.1–2.6
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { validateFile, MAX_FILE_SIZE_BYTES, SUPPORTED_MIME_TYPES } from "./validateFile.js";
import { checkIdempotency, STALENESS_THRESHOLD_SECONDS } from "./checkIdempotency.js";
import type { EvidenceStatus } from "../types/evidence.js";

// ---------------------------------------------------------------------------
// validateFile — Property 1
// ---------------------------------------------------------------------------
describe("validateFile (Property P1: File Acceptance Predicate)", () => {
  it("P1: accepts all supported MIME types at exactly 100 MB", () => {
    for (const mime of Object.keys(SUPPORTED_MIME_TYPES)) {
      const result = validateFile(mime, MAX_FILE_SIZE_BYTES);
      expect(result.valid).toBe(true);
    }
  });

  it("P1: rejects all supported MIME types at 100 MB + 1 byte", () => {
    for (const mime of Object.keys(SUPPORTED_MIME_TYPES)) {
      const result = validateFile(mime, MAX_FILE_SIZE_BYTES + 1);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain("100 MB");
    }
  });

  it("rejects an unsupported MIME type", () => {
    const result = validateFile("application/x-unsupported", 1024);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("Unsupported");
  });

  it("P1: property — accepts iff supported type AND size ≤ 100 MB", () => {
    // Feature: evidence-trail, Property 1: File Acceptance Predicate is Consistent
    const supportedMimes = Object.keys(SUPPORTED_MIME_TYPES);
    fc.assert(
      fc.property(
        fc.constantFrom(...supportedMimes),
        fc.integer({ min: 1, max: MAX_FILE_SIZE_BYTES }),
        (mime, size) => {
          const r = validateFile(mime, size);
          expect(r.valid).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("P1: property — rejects any file > 100 MB regardless of type", () => {
    const supportedMimes = Object.keys(SUPPORTED_MIME_TYPES);
    fc.assert(
      fc.property(
        fc.constantFrom(...supportedMimes),
        fc.integer({ min: MAX_FILE_SIZE_BYTES + 1, max: MAX_FILE_SIZE_BYTES * 2 }),
        (mime, size) => {
          const r = validateFile(mime, size);
          expect(r.valid).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// checkIdempotency — Property 5
// ---------------------------------------------------------------------------
describe("checkIdempotency (Property P5: Staleness Window Branch Selection)", () => {
  it("returns FRESH when document is null", () => {
    expect(checkIdempotency(null).branch).toBe("FRESH");
  });

  it("returns COMPLETE_DUPLICATE when status is available", () => {
    expect(checkIdempotency({ status: "available", updatedAt: new Date() }).branch).toBe("COMPLETE_DUPLICATE");
  });

  it("returns STALLED when uploading and updatedAt > 300s ago", () => {
    const staleDate = new Date(Date.now() - (STALENESS_THRESHOLD_SECONDS + 1) * 1000);
    const result = checkIdempotency({ status: "uploading", updatedAt: staleDate });
    expect(result.branch).toBe("STALLED");
  });

  it("returns CONCURRENT when uploading and updatedAt ≤ 300s ago", () => {
    const freshDate = new Date(Date.now() - (STALENESS_THRESHOLD_SECONDS - 10) * 1000);
    const result = checkIdempotency({ status: "uploading", updatedAt: freshDate });
    expect(result.branch).toBe("CONCURRENT");
  });

  it("returns STALLED for processing with stale updatedAt", () => {
    const staleDate = new Date(Date.now() - 400_000);
    expect(checkIdempotency({ status: "processing", updatedAt: staleDate }).branch).toBe("STALLED");
  });

  it("returns TERMINAL for failed/integrity_failed/encryption_failed", () => {
    for (const status of ["failed", "integrity_failed", "encryption_failed", "expired"] as EvidenceStatus[]) {
      const result = checkIdempotency({ status, updatedAt: new Date() });
      expect(result.branch).toBe("TERMINAL");
      if (result.branch === "TERMINAL") expect(result.status).toBe(status);
    }
  });

  it("P5: property — > 300s staleness → STALLED, ≤ 300s → CONCURRENT", () => {
    // Feature: evidence-trail, Property 5: Staleness Window Branch Selection
    fc.assert(
      fc.property(
        fc.integer({ min: STALENESS_THRESHOLD_SECONDS + 1, max: 3600 }),
        (staleSecs) => {
          const updatedAt = new Date(Date.now() - staleSecs * 1000);
          const r = checkIdempotency({ status: "uploading", updatedAt });
          expect(r.branch).toBe("STALLED");
        }
      ),
      { numRuns: 100 }
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: STALENESS_THRESHOLD_SECONDS }),
        (freshSecs) => {
          const updatedAt = new Date(Date.now() - freshSecs * 1000);
          const r = checkIdempotency({ status: "uploading", updatedAt });
          expect(r.branch).toBe("CONCURRENT");
        }
      ),
      { numRuns: 100 }
    );
  });
});
