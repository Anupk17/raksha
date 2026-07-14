/**
 * Injectable Cloud Tasks client interface.
 *
 * All Cloud Functions that need to enqueue deferred tasks use this interface,
 * never the concrete implementations directly. This mirrors the KMS injectable
 * pattern (kms/kms.interface.ts) and is required because the Firebase Emulator
 * Suite does NOT emulate Cloud Tasks — calling the real API from tests would
 * require network access, a real GCP project, and real credentials.
 *
 * The single method this interface exposes covers the only operation this
 * feature needs: scheduling a named HTTP task to be delivered at a specific
 * future time. The handler URL and queue name are passed at call time so the
 * same client instance works for different queues.
 *
 * Design: §Decision 2 — Cloud Tasks (confirmed), §Resolved Design Decisions
 * Requirements: Req 6.5, tasks.md Task 0
 */
export interface CloudTasksClient {
  /**
   * Enqueues an HTTP POST task to the given Cloud Tasks queue.
   *
   * @param queuePath   - Fully-qualified queue resource name:
   *                      "projects/{project}/locations/{location}/queues/{queue}"
   * @param handlerUrl  - The HTTPS URL the Cloud Tasks service will POST to.
   * @param payload     - JSON-serializable body sent as the HTTP request body.
   * @param scheduleMs  - Absolute epoch-millisecond timestamp at which the task
   *                      should be delivered. Must be in the future. Values in the
   *                      past or within 100ms of now are clamped to now + 100ms to
   *                      avoid immediate dispatch races.
   * @param taskName    - Optional stable name for this task, relative to the queue
   *                      (e.g. "activate-{sessionId}"). When provided, Cloud Tasks
   *                      uses this as a deduplication key: re-enqueueing the same
   *                      name within 4 hours returns ALREADY_EXISTS rather than
   *                      creating a duplicate task. The caller should treat
   *                      ALREADY_EXISTS as a success.
   *
   * @returns The Cloud Tasks task name (resource string) on success.
   * @throws  On any transient or permanent enqueue failure (NOT on ALREADY_EXISTS).
   */
  enqueueTask(
    queuePath: string,
    handlerUrl: string,
    payload: Record<string, unknown>,
    scheduleMs: number,
    taskName?: string
  ): Promise<string>;
}
