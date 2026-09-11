/**
 * Graph mutation（02_ARCHITECTURE.md §7、04 §8）。
 *
 * 所有 mutation 不可变：返回新 graph，原对象不动。
 * add_node 的 id 分配：max(纯数字 node ids) + 1；存在非数字 ID 时仍生成未占用的数字字符串。
 * remove_node 有下游引用时失败 NODE_IN_USE（第一版不支持 cascade）。
 */
import { RhError, rhError } from "../errors.js";
import { outgoingConnections } from "./topology.js";
import type {
  GraphOperation,
  PatchResult,
  ValidationIssue,
  WorkflowGraph,
  WorkflowNode,
} from "./types.js";
import { diffGraphs } from "./diff.js";

export function patchGraph(original: WorkflowGraph, operations: GraphOperation[]): PatchResult {
  const warnings: ValidationIssue[] = [];
  const assignedNodeIds: Record<string, string> = {};
  // 深拷贝一次，后续操作在副本上以“替换节点对象”的方式保持不可变外观
  let graph: WorkflowGraph = cloneGraph(original);

  operations.forEach((op, index) => {
    try {
      graph = applyOperation(graph, op, warnings, assignedNodeIds, index);
    } catch (err) {
      if (err instanceof RhError) {
        err.details = { ...err.details, operationIndex: index, operation: describeOperation(op) };
      }
      throw err;
    }
  });

  const diff = diffGraphs(original, graph);
  return { graph, diff, warnings, assignedNodeIds };
}

function applyOperation(
  graph: WorkflowGraph,
  op: GraphOperation,
  warnings: ValidationIssue[],
  assignedNodeIds: Record<string, string>,
  opIndex: number,
): WorkflowGraph {
  switch (op.type) {
    case "set_input": {
      const node = requireNode(graph, op.nodeId);
      const previous = node.inputs[op.field];
      if (isConnectionLike(previous) && !isConnectionLike(op.value)) {
        warnings.push({
          severity: "warning",
          code: "CONNECTION_REPLACED_BY_VALUE",
          nodeId: op.nodeId,
          field: op.field,
          message: `input "${op.field}" was a connection and is now a constant; use full workflow mode`,
        });
      }
      graph.nodes[op.nodeId] = {
        ...node,
        inputs: { ...node.inputs, [op.field]: structuredCloneable(op.value) },
      };
      return graph;
    }
    case "add_node": {
      if (op.classType.trim() === "") {
        throw rhError("INVALID_WORKFLOW", "add_node requires a non-empty classType");
      }
      let nodeId = op.nodeId;
      if (nodeId !== undefined) {
        if (graph.nodes[nodeId] !== undefined) {
          throw rhError("INVALID_WORKFLOW", `node id "${nodeId}" already exists`, {
            nodeId,
          });
        }
      } else {
        nodeId = nextNodeId(graph);
      }
      const node: WorkflowNode = {
        id: nodeId,
        classType: op.classType,
        ...(op.title !== undefined ? { title: op.title } : {}),
        inputs: { ...(op.inputs ?? {}) },
      };
      graph.nodes[nodeId] = node;
      assignedNodeIds[`#${opIndex}`] = nodeId;
      // 稳定回填：按操作序号记录（assignedNodeIds 键在 tool 层换成语义 key）
      warnings.push({
        severity: "warning",
        code: "NODE_ADDED_WITHOUT_SCHEMA",
        nodeId,
        message: `node ${nodeId} (${op.classType}) added without object_info schema check; run validate with useNodeSchema=true`,
      });
      return graph;
    }
    case "remove_node": {
      requireNode(graph, op.nodeId);
      const downstream = outgoingConnections(graph, op.nodeId);
      if (downstream.length > 0) {
        throw rhError("NODE_IN_USE", `node "${op.nodeId}" still has downstream connections`, {
          nodeId: op.nodeId,
          downstream,
        });
      }
      const nodes = { ...graph.nodes };
      delete nodes[op.nodeId];
      return { nodes };
    }
    case "connect": {
      const from = requireNode(graph, op.fromNode);
      const to = requireNode(graph, op.toNode);
      if (!Number.isInteger(op.outputIndex) || op.outputIndex < 0) {
        throw rhError("INVALID_WORKFLOW", "outputIndex must be a non-negative integer", {
          fromNode: op.fromNode,
        });
      }
      if (from.id === to.id) {
        throw rhError("INVALID_WORKFLOW", `self connection on node "${op.toNode}" is not allowed`);
      }
      if (!(op.input in to.inputs)) {
        warnings.push({
          severity: "warning",
          code: "UNKNOWN_INPUT_NAME",
          nodeId: op.toNode,
          field: op.input,
          message: `input "${op.input}" not present on node ${op.toNode}; created it (schema unknown — verify with object_info)`,
        });
      }
      graph.nodes[op.toNode] = {
        ...to,
        inputs: { ...to.inputs, [op.input]: [op.fromNode, op.outputIndex] },
      };
      return graph;
    }
    case "disconnect": {
      const to = requireNode(graph, op.toNode);
      if (!(op.input in to.inputs)) {
        warnings.push({
          severity: "warning",
          code: "INPUT_NOT_FOUND",
          nodeId: op.toNode,
          field: op.input,
          message: `input "${op.input}" not present on node ${op.toNode}; nothing to disconnect`,
        });
        return graph;
      }
      // 无 schema 时按 02 §7：删除并 warning（required connection 的判留给 Level 2 validator）
      const nodes = { ...graph.nodes, [op.toNode]: omitInput(to, op.input) };
      warnings.push({
        severity: "warning",
        code: "DISCONNECT_WITHOUT_SCHEMA",
        nodeId: op.toNode,
        field: op.input,
        message: `input "${op.input}" removed without schema knowledge; if it is required the workflow will fail validation`,
      });
      return { nodes };
    }
    default: {
      const exhaustive: never = op;
      throw rhError("INVALID_WORKFLOW", `unknown operation type: ${String(exhaustive)}`);
    }
  }
}

/** 下一个可用数字 node id：max(数字 ids) + 1；无数字 id 时从 1 开始 */
export function nextNodeId(graph: WorkflowGraph): string {
  let max = 0;
  for (const id of Object.keys(graph.nodes)) {
    if (/^\d+$/.test(id)) {
      const n = Number(id);
      if (n > max) max = n;
    }
  }
  let candidate = max + 1;
  // 已存在非数字风格冲突时递增到未占用
  while (graph.nodes[String(candidate)] !== undefined) candidate += 1;
  return String(candidate);
}

function requireNode(graph: WorkflowGraph, nodeId: string): WorkflowNode {
  const node = graph.nodes[nodeId];
  if (!node) {
    throw rhError("NODE_NOT_FOUND", `node "${nodeId}" not found in workflow`, { nodeId });
  }
  return node;
}

function omitInput(node: WorkflowNode, field: string): WorkflowNode {
  const inputs = { ...node.inputs };
  delete inputs[field];
  return { ...node, inputs };
}

function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  const nodes: Record<string, WorkflowNode> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    nodes[id] = {
      ...node,
      inputs: { ...node.inputs },
      ...(node.rawMeta ? { rawMeta: { ...node.rawMeta } } : {}),
    };
  }
  return { nodes };
}

function isConnectionLike(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    Number.isInteger(value[1])
  );
}

function structuredCloneable(value: unknown): unknown {
  return value === undefined ? null : value;
}

function describeOperation(op: GraphOperation): string {
  return JSON.stringify(op);
}
