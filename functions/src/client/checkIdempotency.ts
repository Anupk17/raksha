/**
 * Three-branch idempotency check (Req 2.1–2.6, design §Upload Flow Step 3).
 *
 * FRESH             — no document → proceed with new upload
 * COMPLETE_DUPLICATE — status 'available' → return success immediately
 * STALLED           — uploading/processing AND updatedAt > 300s ago → attempt resume
 * CONCURRENT        — uploading/processing AND updatedAt ≤ 300s ago → in-flight, wait
 * TERMINAL          — failed/integrity_failed/encryption_failed/expired → do not retry
 * NETWORK_ERROR     — could not read status after 1 retry
 *
 * A two-branch "if exists → skip" pattern is explicitly prohibited (Req 2.5).
 */
import type { IdempotencyResult, EvidenceStatus } from "../types/evidence.js";

export const STALENESS_THRESHOLD_SECONDS = 300;

/** Minimal document shape needed for the idempotency check. */
export interface DocumentStatus {
  status: EvidenceStatus;
  updatedAt: Date;
}

export function checkIdempotency(
  existing: DocumentStatus | null
): IdempotencyResult {
  // Branch A: no document → fresh upload
  if (existing === null) {
    return { branch: "FRESH" };
  }

  const { status, updatedAt } = existing;

  // Branch B: already successfully processed
  if (status === "available") {
    return { branch: "COMPLETE_DUPLICATE" };
  }

  // Branch C: stalled or concurrent
  if (status === "uploading" || status === "processing") {
    const stalenessSeconds = (Date.now() - updatedAt.getTime()) / 1000;
    if (stalenessSeconds > STALENESS_THRESHOLD_SECONDS) {
      return { branch: "STALLED" };
    }
    return { branch: "CONCURRENT" };
  }

  // Terminal: failed, integrity_failed, encryption_failed, expired, legal_hold
  return { branch: "TERMINAL", status };
}
