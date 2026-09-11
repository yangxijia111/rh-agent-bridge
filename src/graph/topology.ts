/**
 * 连接识别与拓扑（02_ARCHITECTURE.md §3）。
 *
 * 边的形态：["nodeId", outputIndex]。
 * 无 schema 时按形态识别；有 schema 时应由上层（validator）用 schema 复核，
 * 避免“真正的二元素业务数组”被误判（例如某些节点的数值对输入）。
 */
import type { Connection, ConnectionValue, WorkflowGraph } from "./types.js";

/** 形态判断：是否为连接值 */
export function isConnectionValue(value: unknown): value is ConnectionValue {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    Number.isInteger(value[1]) &&
    (value[1] as number) >= 0
  );
}

/** 提取图中全部连接 */
export function extractConnections(graph: WorkflowGraph): Connection[] {
  const out: Connection[] = [];
  for (const node of Object.values(graph.nodes)) {
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (isConnectionValue(value)) {
        out.push({
          fromNode: value[0],
          outputIndex: value[1],
          toNode: node.id,
          inputName,
        });
      }
    }
  }
  return out;
}

/** 指定节点的入边 */
export function incomingConnections(graph: WorkflowGraph, nodeId: string): Connection[] {
  return extractConnections(graph).filter((c) => c.toNode === nodeId);
}

/** 指定节点的出边（其他节点引用它的边） */
export function outgoingConnections(graph: WorkflowGraph, nodeId: string): Connection[] {
  return extractConnections(graph).filter((c) => c.fromNode === nodeId);
}

/**
 * 检测环（FR-05：普通 ComfyUI workflow 视为无环依赖图）。
 * 返回参与环的节点 id 集合（可能多个环合并返回）。
 */
export function detectCycleNodes(graph: WorkflowGraph): string[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const inCycle = new Set<string>();

  const adjacency = buildAdjacency(graph);

  const visit = (nodeId: string, path: string[]): void => {
    color.set(nodeId, GRAY);
    path.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      // next 依赖 nodeId；沿依赖方向走，GRAY 即成环
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // 把当前栈中从 next 开始的部分标记为环成员
        const start = path.indexOf(next);
        for (let i = start; i < path.length; i += 1) inCycle.add(path[i]!);
      } else if (c === WHITE) {
        visit(next, path);
      }
    }
    path.pop();
    color.set(nodeId, BLACK);
  };

  for (const id of Object.keys(graph.nodes)) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id, []);
  }
  return [...inCycle];
}

/** adjacency：nodeId → 它依赖的节点集合（其输入连接的 fromNode） */
function buildAdjacency(graph: WorkflowGraph): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const id of Object.keys(graph.nodes)) adjacency.set(id, new Set());
  for (const connection of extractConnections(graph)) {
    adjacency.get(connection.toNode)?.add(connection.fromNode);
  }
  return adjacency;
}
