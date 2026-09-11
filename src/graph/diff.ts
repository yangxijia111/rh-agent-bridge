/**
 * 图 diff（04_TOOL_AND_MCP_SPEC §14）。
 * 输出 nodesAdded / nodesRemoved / connectionsAdded / connectionsRemoved / inputsChanged，
 * 并派生 topologyChanged 与 classTypesChanged（M4 执行策略的输入）。
 */
import type { Connection, WorkflowDiff, WorkflowGraph } from "./types.js";
import { emptyDiff } from "./types.js";
import { extractConnections } from "./topology.js";
import { deepEqual } from "./deep-equal.js";

export function diffGraphs(before: WorkflowGraph, after: WorkflowGraph): WorkflowDiff {
  const diff = emptyDiff();
  const beforeIds = new Set(Object.keys(before.nodes));
  const afterIds = new Set(Object.keys(after.nodes));

  for (const id of afterIds) {
    if (!beforeIds.has(id)) diff.nodesAdded.push(id);
  }
  for (const id of beforeIds) {
    if (!afterIds.has(id)) diff.nodesRemoved.push(id);
  }

  // class type 变化（同 id 节点换类型）
  for (const id of beforeIds) {
    if (afterIds.has(id) && before.nodes[id]!.classType !== after.nodes[id]!.classType) {
      diff.classTypesChanged = true;
    }
  }

  // 连接 diff：以“fromNode/outputIndex/toNode/inputName”四元组为键
  const beforeConnections = new Map(extractConnections(before).map((c) => [connectionKey(c), c]));
  const afterConnections = new Map(extractConnections(after).map((c) => [connectionKey(c), c]));
  for (const [key, c] of afterConnections) {
    if (!beforeConnections.has(key)) diff.connectionsAdded.push(c);
  }
  for (const [key, c] of beforeConnections) {
    if (!afterConnections.has(key)) diff.connectionsRemoved.push(c);
  }

  // 同 id 节点的输入变化
  for (const id of beforeIds) {
    if (!afterIds.has(id)) continue;
    const beforeNode = before.nodes[id]!;
    const afterNode = after.nodes[id]!;
    for (const field of new Set([...Object.keys(beforeNode.inputs), ...Object.keys(afterNode.inputs)])) {
      const b = beforeNode.inputs[field];
      const a = afterNode.inputs[field];
      if (!deepEqual(b, a)) {
        diff.inputsChanged.push({ nodeId: id, field, before: b ?? null, after: a ?? null });
      }
    }
  }

  diff.topologyChanged =
    diff.nodesAdded.length > 0 ||
    diff.nodesRemoved.length > 0 ||
    diff.connectionsAdded.length > 0 ||
    diff.connectionsRemoved.length > 0 ||
    diff.classTypesChanged;

  return diff;
}

function connectionKey(c: Connection): string {
  return `${c.fromNode}/${c.outputIndex}->${c.toNode}/${c.inputName}`;
}
