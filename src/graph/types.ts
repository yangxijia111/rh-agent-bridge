/**
 * Graph domain 核心类型（02_ARCHITECTURE.md §3）。
 *
 * 本层纯函数、无网络依赖；禁止 import fetch / playwright / mcp / process.env。
 */

/** 结构化工作流图 */
export interface WorkflowGraph {
  nodes: Record<string, WorkflowNode>;
}

export interface WorkflowNode {
  id: string;
  classType: string;
  title?: string;
  /** 节点输入：既包括常量值，也包括连接（[fromNode, outputIndex]） */
  inputs: Record<string, unknown>;
  /** 原始 _meta（title 之外的额外元数据保留） */
  rawMeta?: Record<string, unknown>;
}

/** 一条连接（edge） */
export interface Connection {
  fromNode: string;
  outputIndex: number;
  toNode: string;
  inputName: string;
}

/** 连接在 API Format 中的原始形态：["nodeId", outputIndex] */
export type ConnectionValue = [string, number];

/** Graph mutation 操作（01_PRD.md FR-04） */
export type GraphOperation =
  | { type: "set_input"; nodeId: string; field: string; value: unknown }
  | {
      type: "add_node";
      nodeId?: string;
      classType: string;
      inputs?: Record<string, unknown>;
      title?: string;
    }
  | { type: "remove_node"; nodeId: string }
  | {
      type: "connect";
      fromNode: string;
      outputIndex: number;
      toNode: string;
      input: string;
    }
  | { type: "disconnect"; toNode: string; input: string };

/** 图差异（04_TOOL_AND_MCP_SPEC §14 + 05 M4） */
export interface WorkflowDiff {
  topologyChanged: boolean;
  /** 任一节点的 class_type 发生变化 */
  classTypesChanged: boolean;
  nodesAdded: string[];
  nodesRemoved: string[];
  connectionsAdded: Connection[];
  connectionsRemoved: Connection[];
  inputsChanged: Array<{
    nodeId: string;
    field: string;
    before: unknown;
    after: unknown;
  }>;
}

export function emptyDiff(): WorkflowDiff {
  return {
    topologyChanged: false,
    classTypesChanged: false,
    nodesAdded: [],
    nodesRemoved: [],
    connectionsAdded: [],
    connectionsRemoved: [],
    inputsChanged: [],
  };
}

/** 校验问题（M3 Validator 输出） */
export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  nodeId?: string;
  field?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/** patch 结果（02_ARCHITECTURE.md §7） */
export interface PatchResult {
  graph: WorkflowGraph;
  diff: WorkflowDiff;
  warnings: ValidationIssue[];
  /** add_node 实际分配的 nodeId（按 operation 顺序） */
  assignedNodeIds: Record<string, string>;
}
