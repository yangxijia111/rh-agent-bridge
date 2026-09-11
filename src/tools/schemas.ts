/**
 * 工具层共享 zod schemas（04_TOOL_AND_MCP_SPEC）。
 */
import { z } from "zod";
import type { WorkflowGraph } from "../graph/types.js";
import { parseApiFormat } from "../graph/parse.js";
import { rhError } from "../errors.js";

/** JSON 值 union：z.unknown() 在 zod 中等价 optional，无法表达 required，故用显式 union */
const jsonValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.unknown()),
]);

/** patch operation 输入（FR-04） */
export const graphOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set_input"),
    nodeId: z.string().min(1),
    field: z.string().min(1),
    value: jsonValueSchema,
  }),
  z.object({
    type: z.literal("add_node"),
    nodeId: z.string().min(1).optional(),
    classType: z.string().min(1),
    inputs: z.record(z.unknown()).optional(),
    title: z.string().optional(),
  }),
  z.object({ type: z.literal("remove_node"), nodeId: z.string().min(1) }),
  z.object({
    type: z.literal("connect"),
    fromNode: z.string().min(1),
    outputIndex: z.number().int().nonnegative(),
    toNode: z.string().min(1),
    input: z.string().min(1),
  }),
  z.object({ type: z.literal("disconnect"), toNode: z.string().min(1), input: z.string().min(1) }),
]);

/** nodeInfoList 条目（官方结构） */
export const nodeInfoOverrideInputSchema = z.object({
  nodeId: z.string().min(1),
  fieldName: z.string().min(1),
  fieldValue: jsonValueSchema,
});

/**
 * WorkflowGraph 的 wire 形态（结构化）：
 * { nodes: { "3": { id, classType, title?, inputs } } }
 */
export const workflowGraphJsonSchema = z.object({
  nodes: z.record(
    z.string(),
    z.object({
      id: z.string(),
      classType: z.string().min(1),
      title: z.string().optional(),
      inputs: z.record(z.unknown()).default({}),
    }),
  ),
});

/** 解析 wire 形态 → WorkflowGraph（P0.1-05：key/id 不一致直接拒绝，不静默纠正） */
export function graphFromWire(value: z.infer<typeof workflowGraphJsonSchema>): WorkflowGraph {
  const nodes: WorkflowGraph["nodes"] = {};
  const seenIds = new Set<string>();
  for (const [key, node] of Object.entries(value.nodes)) {
    const id = node.id.length > 0 ? node.id : key;
    if (id !== key) {
      throw rhError(
        "INVALID_WORKFLOW",
        `wire graph invariant violated: nodes["${key}"].id === "${id}"; map key must equal node id`,
        { key, id },
      );
    }
    if (seenIds.has(id)) {
      throw rhError(
        "INVALID_WORKFLOW",
        `wire graph invariant violated: duplicate node id "${id}"`,
        { id },
      );
    }
    seenIds.add(id);
    nodes[key] = {
      id,
      classType: node.classType,
      ...(node.title !== undefined ? { title: node.title } : {}),
      inputs: node.inputs ?? {},
    };
  }
  return { nodes };
}

/** wire 形态（含 API Format 原样对象自动归一） */
export function graphFromUnknown(value: unknown): WorkflowGraph {
  // 结构化形态
  const structured = workflowGraphJsonSchema.safeParse(value);
  if (structured.success && Object.keys(structured.data.nodes).length > 0) {
    return graphFromWire(structured.data);
  }
  // 兼容直接传 API Format 原样对象
  return parseApiFormat(value);
}
