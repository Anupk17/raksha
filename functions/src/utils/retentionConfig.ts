/**
 * Retention period configuration utility.
 *
 * Reads the globally configured evidence retention period (in whole days)
 * from the EVIDENCE_RETENTION_DAYS environment variable and validates it
 * against the required range [1, 3650].
 *
 * Called by:
 *   - onEvidenceCreate  (Step 9: compute retentionExpiresAt at upload time)
 *   - processEvidenceExpiry (Step 1: validate config before any expiry run)
 *   - releaseLegalHold  (recalculate retentionExpiresAt from current time)
 *
 * If the configured value is outside [1, 3650], the function throws a
 * RangeError. Callers MUST treat this as a fatal configuration error and
 * abort the current operation rather than proceeding with an invalid value.
 *
 * Requirements: 8.1, 8.7
 * Design: §processEvidenceExpiry Function Design — Step 1
 */

/** Minimum retention period in days (inclusive). */
export const MIN_RETENTION_DAYS = 1;

/** Maximum retention period in days (inclusive) — 10 years. */
export const MAX_RETENTION_DAYS = 3650;

/** Default retention period used when env var is not set (90 days). */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Returns the globally configured retention period in whole days.
 *
 * Reads from process.env.EVIDENCE_RETENTION_DAYS. If the variable is not
 * set, returns the default (90 days). If the parsed value is not a whole
 * number in [1, 3650], throws RangeError.
 *
 * @throws RangeError if the configured value is outside [1, 3650] or is
 *                    not a valid whole number.
 */
export function getRetentionPeriodDays(): number {
  const raw = process.env["EVIDENCE_RETENTION_DAYS"];

  if (raw === undefined || raw === "") {
    return DEFAULT_RETENTION_DAYS;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed)) {
    throw new RangeError(
      `getRetentionPeriodDays: EVIDENCE_RETENTION_DAYS must be a whole number ` +
        `(got "${raw}", parsed as ${parsed})`
    );
  }

  if (parsed < MIN_RETENTION_DAYS || parsed > MAX_RETENTION_DAYS) {
    throw new RangeError(
      `getRetentionPeriodDays: EVIDENCE_RETENTION_DAYS must be between ` +
        `${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days inclusive ` +
        `(got ${parsed})`
    );
  }

  return parsed;
}

/**
 * Computes the retentionExpiresAt Date from a given base timestamp.
 *
 * @param baseDate     - The reference point (createdAt for new documents,
 *                       current server time for hold releases).
 * @param retentionDays - Whole number of days in [1, 3650]. Pass the result
 *                        of getRetentionPeriodDays().
 * @returns baseDate + retentionDays × 86_400_000 milliseconds, exactly.
 */
export function computeRetentionExpiresAt(
  baseDate: Date,
  retentionDays: number
): Date {
  return new Date(baseDate.getTime() + retentionDays * 86_400_000);
}
