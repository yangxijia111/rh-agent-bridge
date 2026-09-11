/**
 * WorkflowGraph → API Format JSON（03 §3 的逆向）。
 * 输出可直接 JSON.stringify 后作为 create task 的 workflow 字段。
 *
 * P0.1-05（方案 A）：强 invariant —— graph.nodes[key].id === key。
 * 不一致直接抛 INVALID_WORKFLOW，绝不静默纠正或覆盖（两个 node.id 相同会导致
 * 以 id 为 key 的输出发生 overwrite）。
 */
import { rhError } from "../errors.js";
import type { WorkflowGraph } from "./types.js";

export function serializeApiFormat(graph: WorkflowGraph): Record<string, unknown> {
  assertIdInvariant(graph);
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

/**
 * P0.1-05：boundary invariant 校验。
 * - map key 必须等于 node.id；
 * - 所有 node.id 唯一（防 serialize 时 overwrite）。
 * @throws rhError(INVALID_WORKFLOW)
 */
export function assertIdInvariant(graph: WorkflowGraph): void {
  const seenIds = new Set<string>();
  for (const [key, node] of Object.entries(graph.nodes)) {
    if (node.id !== key) {
      throw rhError(
        "INVALID_WORKFLOW",
        `graph invariant violated: nodes["${key}"].id === "${node.id}" (key must equal node id)`,
        { key, id: node.id },
      );
    }
    if (seenIds.has(node.id)) {
      throw rhError(
        "INVALID_WORKFLOW",
        `graph invariant violated: duplicate node id "${node.id}"`,
        { id: node.id },
      );
    }
    seenIds.add(node.id);
  }
}
