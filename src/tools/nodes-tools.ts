/**
 * Node catalog 工具（04 §5/§6）：能力探测与节点搜索。
 * 幂等（带 TTL 缓存；refresh 强制刷新）。
 */
import { z } from "zod";
import type { BridgeContext } from "../services/context.js";

export const nodesProbeInputSchema = z.object({
  refresh: z.boolean().optional().default(false),
});

export async function nodesProbeTool(
  ctx: BridgeContext,
  input: z.infer<typeof nodesProbeInputSchema>,
) {
  const snapshot = await ctx.catalog.probe(input.refresh);
  return {
    source: snapshot.source,
    count: snapshot.count,
    capabilities: snapshot.capabilities,
    cacheAgeMs: snapshot.cacheAgeMs,
  };
}

export const nodeSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional().default(10),
});

export async function nodeSearchTool(
  ctx: BridgeContext,
  input: z.infer<typeof nodeSearchInputSchema>,
) {
  // catalog 为空（尚未 probe）时先探测一次
  if (ctx.catalog.count() === 0) {
    await ctx.catalog.probe();
  }
  return { matches: ctx.catalog.search(input.query, input.limit) };
}
