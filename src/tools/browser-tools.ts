/**
 * Browser fallback 工具（04 §15）。
 * 本工具不执行浏览器操作，只返回结构化请求（host 模式）。
 */
import { z } from "zod";
import type { BridgeContext } from "../services/context.js";

export const browserFallbackRequestInputSchema = z.object({
  workflowId: z.string().min(1),
  goal: z.string().min(1),
  context: z.record(z.unknown()).optional(),
});

export async function browserFallbackRequestTool(
  ctx: BridgeContext,
  input: z.infer<typeof browserFallbackRequestInputSchema>,
) {
  return ctx.browserFallback.request(input);
}
