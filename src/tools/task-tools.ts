/**
 * Task 工具（04 §12/§13）。
 * outputs 幂等；wait 同步阻塞（支持 timeout 与 abort）。
 */
import { z } from "zod";
import { RhError } from "../errors.js";
import type { BridgeContext } from "../services/context.js";

export const taskOutputsInputSchema = z.object({
  taskId: z.string().min(1),
});

export async function taskOutputsTool(ctx: BridgeContext, input: z.infer<typeof taskOutputsInputSchema>) {
  return ctx.task.outputs(input.taskId);
}

export const taskWaitInputSchema = z.object({
  taskId: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  pollIntervalMs: z.number().int().positive().optional(),
});

export async function taskWaitTool(
  ctx: BridgeContext,
  input: z.infer<typeof taskWaitInputSchema>,
  extra?: { signal?: AbortSignal },
) {
  try {
    return await ctx.task.wait(input.taskId, {
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
      ...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
    });
  } catch (err) {
    if (err instanceof RhError && err.code === "TASK_FAILED") {
      // 结构化失败输出（04 §12 失败样例），不向上抛裸错误
      return {
        state: "FAILED" as const,
        outputs: [],
        error: {
          message: err.message,
          ...(err.details?.msg !== undefined ? { msg: err.details.msg } : {}),
          ...(err.details?.failedReason !== undefined
            ? { failedReason: err.details.failedReason }
            : {}),
        },
      };
    }
    throw err;
  }
}
