/**
 * Factory function that returns the correct CloudTasksClient for the current
 * environment.
 *
 * Returns CloudTasksMock when:
 *   - process.env.FUNCTIONS_EMULATOR === 'true'  (Firebase Emulator Suite)
 *   - process.env.NODE_ENV === 'test'             (vitest)
 *
 * Returns RealCloudTasksClient in all other environments (production, staging).
 *
 * The Firebase Emulator Suite does NOT emulate Cloud Tasks.  Calling the real
 * Cloud Tasks API from tests would require network access, a real GCP project,
 * and real credentials — exactly the same situation as Cloud KMS.  This
 * factory applies the same injectable-client pattern established in
 * kms/createKMSClient.ts (Evidence Trail, Section 6 of
 * RAKSHA_data_models_schema.md).
 *
 * USAGE: Call createCloudTasksClient() once at Cloud Function initialisation
 * time (module scope), not per-request.  The singleton is stable across the
 * lifetime of the function instance.
 *
 * Design: §Decision 2 — Cloud Tasks (confirmed)
 * Requirements: tasks.md Task 0
 *
 * Queue specs (locked — do not change without updating the GCP console):
 *   Queue name  : sos-session-activate
 *   DLQ name    : sos-activate-dlq
 *   Max retries : 3 (4 total attempts)
 *   Initial backoff: 10 s
 *   Max backoff    : 60 s
 *   Monitoring alert: sos-activate-dlq queue depth > 0
 */
import type { CloudTasksClient } from "./cloudTasks.interface.js";
import { CloudTasksMock } from "./CloudTasksMock.js";
import { RealCloudTasksClient } from "./RealCloudTasksClient.js";

export function createCloudTasksClient(): CloudTasksClient {
  if (
    process.env["FUNCTIONS_EMULATOR"] === "true" ||
    process.env["NODE_ENV"] === "test"
  ) {
    return new CloudTasksMock();
  }
  return new RealCloudTasksClient();
}
