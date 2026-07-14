/**
 * RealCloudTasksClient — production Cloud Tasks enqueue implementation.
 *
 * Wraps @google-cloud/tasks v5 to implement the CloudTasksClient interface.
 * This class is NEVER instantiated in test or Firebase Emulator environments;
 * use CloudTasksMock instead (see createCloudTasksClient.ts).
 *
 * Queue specifications (locked — design.md §Decision 2):
 *   Queue        : sos-session-activate
 *   DLQ          : sos-activate-dlq
 *   Max retries  : 3 (4 total attempts — retry policy: maxAttempts=4)
 *   Init backoff : 10 s
 *   Max backoff  : 60 s
 *
 * Service account requirement (Task 0.4):
 *   The Cloud Functions runtime service account must have
 *   roles/cloudtasks.enqueuer on the sos-session-activate queue.
 *
 * Design: §Decision 2 — Cloud Tasks (confirmed)
 * Requirements: tasks.md Task 0
 */
import { CloudTasksClient as GCloudTasksClient } from "@google-cloud/tasks";
import type { CloudTasksClient } from "./cloudTasks.interface.js";

export class RealCloudTasksClient implements CloudTasksClient {
  private readonly client: GCloudTasksClient;

  constructor() {
    // Application Default Credentials are used automatically when running on
    // Cloud Functions (or any GCP runtime with an attached service account).
    this.client = new GCloudTasksClient();
  }

  async enqueueTask(
    queuePath: string,
    handlerUrl: string,
    payload: Record<string, unknown>,
    scheduleMs: number
  ): Promise<string> {
    const now = Date.now();
    // Clamp to at least 100 ms in the future to avoid immediate-dispatch races.
    const clampedMs = Math.max(scheduleMs, now + 100);

    // Cloud Tasks scheduleTime uses seconds (not milliseconds).
    const scheduleSeconds = Math.floor(clampedMs / 1000);

    const body = Buffer.from(JSON.stringify(payload)).toString("base64");

    const [response] = await this.client.createTask({
      parent: queuePath,
      task: {
        scheduleTime: {
          seconds: scheduleSeconds,
        },
        httpRequest: {
          httpMethod: "POST" as const,
          url: handlerUrl,
          headers: {
            "Content-Type": "application/json",
          },
          body,
        },
      },
    });

    // response.name is the fully-qualified task resource name.
    return response.name ?? "";
  }
}
