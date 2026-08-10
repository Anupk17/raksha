/**
 * CloudTasksMock — test/emulator substitute for the real Cloud Tasks client.
 *
 * Used automatically when:
 *   - process.env.FUNCTIONS_EMULATOR === 'true'  (Firebase Emulator Suite)
 *   - process.env.NODE_ENV === 'test'             (vitest)
 *
 * No external calls. Records every enqueued task in-memory so tests can
 * inspect what was enqueued, in what order, and with what schedule time.
 *
 * The mock does NOT execute the handler — it only records the intent.
 * Integration tests that need end-to-end countdown→active behaviour call
 * activateSOSSession directly after the configured delay (via fake timers)
 * rather than going through Cloud Tasks delivery.
 *
 * Design: §Decision 2 — Cloud Tasks, §Resolved Design Decisions
 * Requirements: tasks.md Task 0
 */
import type { CloudTasksClient } from "./cloudTasks.interface.js";

/** A record of one enqueued task, stored by CloudTasksMock. */
export interface EnqueuedTask {
  /** The queue resource path passed to enqueueTask(). */
  queuePath: string;
  /** The handler URL the task would have been delivered to. */
  handlerUrl: string;
  /** The payload that would have been POSTed to the handler. */
  payload: Record<string, unknown>;
  /**
   * The requested delivery time as an epoch-millisecond value.
   * Already clamped to at least enqueuedAt + 100 by the mock, mirroring
   * what the real implementation does.
   */
  scheduleMs: number;
  /** Wall-clock time (epoch ms) when enqueueTask() was called. */
  enqueuedAt: number;
  /**
   * Synthesized task name returned to the caller.
   * When a stable taskName was provided, this equals that name.
   * Otherwise: "mock-task-{index}" — stable and predictable in tests.
   */
  taskName: string;
}

export class CloudTasksMock implements CloudTasksClient {
  private readonly tasks: EnqueuedTask[] = [];
  private taskCounter = 0;

  async enqueueTask(
    queuePath: string,
    handlerUrl: string,
    payload: Record<string, unknown>,
    scheduleMs: number,
    taskName?: string
  ): Promise<string> {
    const enqueuedAt = Date.now();
    // Mirror the real implementation's minimum-100ms clamp
    const clampedScheduleMs = Math.max(scheduleMs, enqueuedAt + 100);

    // If a stable taskName is provided, check for an existing task with that
    // name. Return its recorded name without re-recording — mirrors Cloud Tasks
    // ALREADY_EXISTS dedup behavior within the 4-hour window.
    if (taskName) {
      const existing = this.tasks.find((t) => t.taskName === taskName);
      if (existing) {
        return existing.taskName;
      }
    }

    const resolvedName = taskName ?? `mock-task-${this.taskCounter++}`;

    this.tasks.push({
      queuePath,
      handlerUrl,
      payload,
      scheduleMs: clampedScheduleMs,
      enqueuedAt,
      taskName: resolvedName,
    });

    if (process.env["FUNCTIONS_EMULATOR"] === "true") {
      const delayMs = Math.max(0, clampedScheduleMs - enqueuedAt);
      const projectId = process.env.GCLOUD_PROJECT || "raksha-2d407";
      const targetUrl = handlerUrl || `http://127.0.0.1:5001/${projectId}/us-central1/activateSOSSession`;

      setTimeout(() => {
        fetch(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-cloudtasks-queuename": "sos-session-activate",
          },
          body: JSON.stringify(payload),
        })
          .then((res) => {
            if (!res.ok) {
              console.error(`[CloudTasksMock] Emulator auto-execution failed: status ${res.status}`);
            } else {
              console.log(`[CloudTasksMock] Emulator auto-execution succeeded for sessionId: ${payload["sessionId"]}`);
            }
          })
          .catch((err) => {
            console.error("[CloudTasksMock] Emulator auto-execution error:", err);
          });
      }, delayMs);
    }

    return resolvedName;
  }

  /** All tasks enqueued since this instance was created, in order. */
  get enqueuedTasks(): ReadonlyArray<EnqueuedTask> {
    return this.tasks;
  }

  /** Number of tasks enqueued. Useful for expect(mock.taskCount).toBe(1). */
  get taskCount(): number {
    return this.tasks.length;
  }

  /** Most recently enqueued task, or undefined if none. */
  get lastTask(): EnqueuedTask | undefined {
    return this.tasks[this.tasks.length - 1];
  }

  /** Clear all recorded tasks. Useful in beforeEach hooks. */
  clear(): void {
    this.tasks.length = 0;
    this.taskCounter = 0;
  }
}
