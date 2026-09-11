/**
 * API Format JSON → WorkflowGraph（Level 0 解析，03 §3）。
 *
 * 节点结构：
 *   "3": { "class_type": "KSampler", "inputs": {...}, "_meta": { "title": "..." } }
 */
import { z } from "zod";
import { RhInvalidWorkflowError } from "../errors.js";
import type { WorkflowGraph, WorkflowNode } from "./types.js";

const rawNodeSchema = z.object({
  class_type: z.string().min(1),
  inputs: z.record(z.unknown()).default({}),
  _meta: z.record(z.unknown()).optional(),
});

const rawApiFormatSchema = z.record(z.string(), rawNodeSchema);

/**
 * 解析并校验 API Format JSON（Level 0）。
 * 输入可以是已解析的对象，也可以是 JSON 字符串。
 * @throws RhInvalidWorkflowError（code=INVALID_WORKFLOW）
 */
export function parseApiFormat(input: unknown): WorkflowGraph {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new RhInvalidWorkflowError("workflow JSON is not parseable");
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RhInvalidWorkflowError("workflow must be a JSON object keyed by node id");
  }
  const parsed = rawApiFormatSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new RhInvalidWorkflowError(
      `workflow node structure invalid at ${first?.path.join(".") ?? "?"}: ${first?.message ?? "unknown"}`,
      { zodIssues: parsed.error.issues.slice(0, 5) },
    );
  }
  const nodes: Record<string, WorkflowNode> = {};
  for (const [id, raw] of Object.entries(parsed.data)) {
    const meta = raw._meta as { title?: unknown } | undefined;
    const title = meta && typeof meta.title === "string" ? meta.title : undefined;
    nodes[id] = {
      id,
      classType: raw.class_type,
      ...(title !== undefined ? { title } : {}),
      inputs: { ...raw.inputs },
      ...(raw._meta !== undefined ? { rawMeta: { ...raw._meta } } : {}),
    };
  }
  return { nodes };
}
