/**
 * 图查询（US-02）：列出节点、按 class/title 搜索、查看连接。
 */
import { rhError } from "../errors.js";
import type { Connection, WorkflowGraph, WorkflowNode } from "./types.js";
import { extractConnections, incomingConnections, isConnectionValue } from "./topology.js";

export interface NodeView {
  id: string;
  classType: string;
  title?: string;
  /** 非连接输入（常量值） */
  inputs: Record<string, unknown>;
  connections: Array<{ input: string; fromNode: string; outputIndex: number }>;
}

export function listNodes(graph: WorkflowGraph): NodeView[] {
  return Object.values(graph.nodes)
    .map(toNodeView)
    .sort((a, b) => numericAwareCompare(a.id, b.id));
}

export function getNode(graph: WorkflowGraph, nodeId: string): WorkflowNode {
  const node = graph.nodes[nodeId];
  if (!node) {
    throw rhError("NODE_NOT_FOUND", `node "${nodeId}" not found in workflow`, {
      nodeId,
    });
  }
  return node;
}

/** 按 classType / title 模糊搜索（大小写不敏感，支持子串） */
export function findNodes(graph: WorkflowGraph, query: string): NodeView[] {
  const q = query.trim().toLowerCase();
  if (q === "") return listNodes(graph);
  return listNodes(graph).filter(
    (n) =>
      n.classType.toLowerCase().includes(q) ||
      (n.title?.toLowerCase().includes(q) ?? false) ||
      n.id === query,
  );
}

export function nodeConnections(graph: WorkflowGraph, nodeId: string): {
  incoming: Connection[];
  outgoing: Connection[];
} {
  return {
    incoming: incomingConnections(graph, nodeId),
    outgoing: extractConnections(graph).filter((c) => c.fromNode === nodeId),
  };
}

export function toNodeView(node: WorkflowNode): NodeView {
  const inputs: Record<string, unknown> = {};
  const connections: NodeView["connections"] = [];
  for (const [key, value] of Object.entries(node.inputs)) {
    if (isConnectionValue(value)) {
      connections.push({ input: key, fromNode: value[0], outputIndex: value[1] });
    } else {
      inputs[key] = value;
    }
  }
  return {
    id: node.id,
    classType: node.classType,
    ...(node.title !== undefined ? { title: node.title } : {}),
    inputs,
    connections,
  };
}

/** 数字优先排序，混合 id 时保持稳定 */
function numericAwareCompare(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const aNum = Number.isInteger(na) && /^\d+$/.test(a);
  const bNum = Number.isInteger(nb) && /^\d+$/.test(b);
  if (aNum && bNum) return na - nb;
  if (aNum) return -1;
  if (bNum) return 1;
  return a.localeCompare(b);
}
