/**
 * TaskService：outputs 查询 + 同步 wait 轮询（FR-07、05 任务轮询）。
 *
 * 默认 polling（不用不稳定的 WSS）；退避 1s,1s,2s,2s,3s,5s 后固定 5s。
 * FAILED 在 service 层抛 RhError(TASK_FAILED)（05），tool 层转 JSON。
 */
import type { RunningHubClient } from "../clients/runninghub/client.js";
import type { TaskOutputsResult } from "../clients/runninghub/task.js";
import type { Logger } from "../config/logger.js";
import { rhError } from "../errors.js";

export interface TaskWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** 时钟与睡眠注入（测试用） */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const BACKOFF_SCHEDULE_MS = [1000, 1000, 2000, 2000, 3000, 5000];
const SETTLED_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class TaskService {
  constructor(
    private readonly rh: RunningHubClient,
    private readonly logger?: Logger,
  ) {}

  outputs(taskId: string): Promise<TaskOutputsResult> {
    return this.rh.task.getTaskOutputs(taskId);
  }

  /**
   * 轮询直到 SUCCEEDED / FAILED / timeout / abort。
   * @throws RhError(TASK_TIMEOUT) / RhError(ABORTED) / RhError(TASK_FAILED with failedReason)
   */
  async wait(taskId: string, options: TaskWaitOptions = {}): Promise<TaskOutputsResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fixedInterval = options.pollIntervalMs;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = options.now ?? Date.now;
    const deadline = now() + timeoutMs;
    let pollIndex = 0;

    for (;;) {
      if (options.signal?.aborted) {
        throw rhError("ABORTED", `task wait aborted by caller (taskId=${taskId})`, { taskId });
      }
      const result = await this.rh.task.getTaskOutputs(taskId);
      if (result.state === "SUCCEEDED") return result;
      if (result.state === "FAILED") {
        throw rhError("TASK_FAILED", `task ${taskId} failed`, {
          taskId,
          msg: result.msg,
          ...(result.failedReason !== undefined ? { failedReason: result.failedReason } : {}),
        });
      }
      const nextDelay = fixedInterval ?? nextBackoffMs(pollIndex);
      pollIndex += 1;
      if (now() + nextDelay >= deadline) {
        throw rhError("TASK_TIMEOUT", `task ${taskId} did not finish within ${timeoutMs}ms`, {
          taskId,
          lastState: result.state,
        });
      }
      this.logger?.debug("task pending, polling again", {
        taskId,
        state: result.state,
        nextDelayMs: nextDelay,
      });
      await sleep(nextDelay);
    }
  }
}

function nextBackoffMs(pollIndex: number): number {
  return pollIndex < BACKOFF_SCHEDULE_MS.length
    ? BACKOFF_SCHEDULE_MS[pollIndex]!
    : SETTLED_INTERVAL_MS;
}
