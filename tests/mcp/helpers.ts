import type { WorkflowGraph } from "../../src/graph/types.js";

/** WorkflowGraph → MCP wire 形态（与 tools/schemas.ts 的结构化 schema 对应） */
export function graphToWire(graph: WorkflowGraph): { nodes: Record<string, unknown> } {
  const nodes: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    nodes[id] = {
      id: node.id,
      classType: node.classType,
      ...(node.title !== undefined ? { title: node.title } : {}),
      inputs: node.inputs,
    };
  }
  return { nodes };
}
