/**
 * WorkflowGraph → API Format JSON（03 §3 的逆向）。
 * 输出可直接 JSON.stringify 后作为 create task 的 workflow 字段。
 */
import type { WorkflowGraph } from "./types.js";

export function serializeApiFormat(graph: WorkflowGraph): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of Object.values(graph.nodes)) {
    const raw: Record<string, unknown> = {
      class_type: node.classType,
      inputs: node.inputs,
    };
    const meta: Record<string, unknown> = { ...(node.rawMeta ?? {}) };
    if (node.title !== undefined) meta.title = node.title;
    if (Object.keys(meta).length > 0) raw._meta = meta;
    out[node.id] = raw;
  }
  return out;
}
