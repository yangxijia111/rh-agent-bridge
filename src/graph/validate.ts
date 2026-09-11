/**
 * 静态校验器（02_ARCHITECTURE.md §8 验证分层、01_PRD.md FR-05）。
 *
 * Level 0 JSON      — parseApiFormat 内完成
 * Level 1 graph     — 引用 / 自引用 / outputIndex / cycle / output node
 * Level 2 schema    — 需 object_info（nodeSchemas 提供；缺失时跳过）
 * Level 3 resource  — 需 model list（models 提供；缺失时跳过）
 * Level 4 remote    — create task 的 promptTips（见 services/workflow.ts，不在本层）
 */
import type {
  NodeInputSpec,
  NodeSchemaLookup,
} from "../catalog/nodes.js";
import { isConnectionTypeSpec } from "../catalog/nodes.js";
import type { ValidationIssue, ValidationResult, WorkflowGraph } from "./types.js";
import { detectCycleNodes, extractConnections, isConnectionValue } from "./topology.js";

export interface ModelRegistry {
  checkpoints?: string[];
  loras?: string[];
  vae?: string[];
  upscaleModels?: string[];
}

export interface ValidateOptions {
  nodeSchemas?: NodeSchemaLookup;
  models?: ModelRegistry;
  /** 是否把 Level 3 模型未命中升级为 error（默认 warning，模型列表可能不完整） */
  strictModels?: boolean;
}

/** 常见模型字段名 → registry 键 */
const MODEL_FIELD_MAP: Record<string, keyof ModelRegistry> = {
  ckpt_name: "checkpoints",
  checkpoint_name: "checkpoints",
  lora_name: "loras",
  vae_name: "vae",
  upscale_model: "upscaleModels",
};

export function validateGraph(graph: WorkflowGraph, options: ValidateOptions = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(Object.keys(graph.nodes));

  /* -------- Level 1：结构引用 -------- */
  if (nodeIds.size === 0) {
    issues.push({ severity: "error", code: "EMPTY_GRAPH", message: "workflow graph has no nodes" });
    return { valid: false, issues };
  }

  for (const node of Object.values(graph.nodes)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      // 形态外连接：[string, 负数] 或 [string, 非整数]
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === "string" &&
        typeof value[1] === "number"
      ) {
        if (!Number.isInteger(value[1]) || value[1] < 0) {
          issues.push({
            severity: "error",
            code: "INVALID_OUTPUT_INDEX",
            nodeId: node.id,
            field,
            message: `output index must be a non-negative integer, got ${value[1]}`,
          });
          continue;
        }
        if (value[0] === node.id) {
          issues.push({
            severity: "error",
            code: "SELF_REFERENCE",
            nodeId: node.id,
            field,
            message: `node "${node.id}" input "${field}" references itself`,
          });
          continue;
        }
        if (!nodeIds.has(value[0])) {
          issues.push({
            severity: "error",
            code: "MISSING_UPSTREAM_NODE",
            nodeId: node.id,
            field,
            message: `input "${field}" references missing node "${value[0]}"`,
          });
        }
      }
    }
  }

  // cycle（普通 ComfyUI workflow 视为无环依赖图）
  const cycleNodes = detectCycleNodes(graph);
  if (cycleNodes.length > 0) {
    issues.push({
      severity: "error",
      code: "CYCLE_DETECTED",
      message: `dependency cycle detected among nodes: ${cycleNodes.join(", ")}`,
    });
  }

  /* -------- Level 2：object_info schema -------- */
  const schemas = options.nodeSchemas;
  if (schemas && schemas.count() > 0) {
    let hasOutputNode = false;
    for (const node of Object.values(graph.nodes)) {
      const def = schemas.get(node.classType);
      if (!def) {
        issues.push({
          severity: "error",
          code: "NODE_NOT_FOUND",
          nodeId: node.id,
          message: `node class "${node.classType}" (node ${node.id}) not found in object_info catalog`,
        });
        continue;
      }
      if (def.outputNode) hasOutputNode = true;
      validateNodeAgainstSchema(node, def.inputRequired, def.inputOptional, issues);
    }
    if (!hasOutputNode) {
      issues.push({
        severity: "error",
        code: "NO_OUTPUT_NODE",
        message: "no output node (e.g. SaveImage) in workflow; nothing would execute",
      });
    }
  } else {
    issues.push({
      severity: "warning",
      code: "SCHEMA_UNAVAILABLE",
      message: "object_info unavailable; only structural (Level 1) validation was performed",
    });
  }

  /* -------- Level 3：model / resource -------- */
  if (options.models) {
    validateModels(graph, options.models, options.strictModels ?? false, issues);
  }

  const valid = !issues.some((i) => i.severity === "error");
  return { valid, issues };
}

function validateNodeAgainstSchema(
  node: { id: string; classType: string; inputs: Record<string, unknown> },
  required: Record<string, NodeInputSpec>,
  optional: Record<string, NodeInputSpec>,
  issues: ValidationIssue[],
): void {
  const known = { ...required, ...optional };
  // required input 存在性
  for (const [field, spec] of Object.entries(required)) {
    if (!(field in node.inputs)) {
      issues.push({
        severity: "error",
        code: "MISSING_REQUIRED_INPUT",
        nodeId: node.id,
        field,
        message: `${node.classType}.${field} is required`,
      });
      continue;
    }
    checkInputValue(node, field, node.inputs[field], spec, issues);
  }
  // optional input 类型
  for (const [field, value] of Object.entries(node.inputs)) {
    if (field in optional && !(field in required)) {
      checkInputValue(node, field, value, optional[field]!, issues);
    } else if (!(field in known)) {
      issues.push({
        severity: "warning",
        code: "UNKNOWN_INPUT_FIELD",
        nodeId: node.id,
        field,
        message: `input "${field}" not defined in ${node.classType} schema`,
      });
    }
  }
}

function checkInputValue(
  node: { id: string; classType: string },
  field: string,
  value: unknown,
  spec: NodeInputSpec,
  issues: ValidationIssue[],
): void {
  const connected = isConnectionValue(value);
  if (connected) return; // 连接值交给连接类型检查
  if (isConnectionTypeSpec(spec)) {
    // MODEL/CLIP/... 类型必须来自连接
    issues.push({
      severity: "error",
      code: "CONNECTION_EXPECTED",
      nodeId: node.id,
      field,
      message: `${node.classType}.${field} expects a connection of type ${spec.type}, got a constant value`,
    });
    return;
  }
  switch (spec.type) {
    case "INT":
    case "FLOAT": {
      if (typeof value !== "number") {
        issues.push({
          severity: "error",
          code: "INVALID_INPUT_TYPE",
          nodeId: node.id,
          field,
          message: `${node.classType}.${field} expects ${spec.type}, got ${typeof value}`,
        });
        break;
      }
      if (spec.min !== undefined && value < spec.min) {
        issues.push({
          severity: "error",
          code: "VALUE_OUT_OF_RANGE",
          nodeId: node.id,
          field,
          message: `${node.classType}.${field}=${value} below min ${spec.min}`,
        });
      }
      if (spec.max !== undefined && value > spec.max) {
        issues.push({
          severity: "error",
          code: "VALUE_OUT_OF_RANGE",
          nodeId: node.id,
          field,
          message: `${node.classType}.${field}=${value} above max ${spec.max}`,
        });
      }
      if (spec.type === "INT" && !Number.isInteger(value)) {
        issues.push({
          severity: "error",
          code: "INVALID_INPUT_TYPE",
          nodeId: node.id,
          field,
          message: `${node.classType}.${field} expects INT, got non-integer ${value}`,
        });
      }
      break;
    }
    case "STRING":
      if (typeof value !== "string") {
        issues.push({
          severity: "error",
          code: "INVALID_INPUT_TYPE",
          nodeId: node.id,
          field,
          message: `${node.classType}.${field} expects STRING, got ${typeof value}`,
        });
      }
      break;
    case "BOOLEAN":
      if (typeof value !== "boolean") {
        issues.push({
          severity: "error",
          code: "INVALID_INPUT_TYPE",
          nodeId: node.id,
          field,
          message: `${node.classType}.${field} expects BOOLEAN, got ${typeof value}`,
        });
      }
      break;
    case "COMBO": {
      if (typeof value !== "string" && typeof value !== "number") {
        issues.push({
          severity: "error",
          code: "INVALID_INPUT_TYPE",
          nodeId: node.id,
          field,
          message: `${node.classType}.${field} expects a COMBO selection, got ${typeof value}`,
        });
        break;
      }
      if (spec.options && spec.options.length > 0 && !spec.options.includes(value)) {
        issues.push({
          severity: "error",
          code: "INVALID_ENUM_VALUE",
          nodeId: node.id,
          field,
          message: `${node.classType}.${field}="${String(value)}" not in available options (${spec.options.length} choices)`,
        });
      }
      break;
    }
    default:
      break;
  }
}

function validateModels(
  graph: WorkflowGraph,
  models: ModelRegistry,
  strict: boolean,
  issues: ValidationIssue[],
): void {
  for (const node of Object.values(graph.nodes)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string") continue;
      const registryKey = MODEL_FIELD_MAP[field];
      if (!registryKey) continue;
      const list = models[registryKey];
      if (!list || list.length === 0) continue;
      if (!list.includes(value)) {
        issues.push({
          severity: strict ? "error" : "warning",
          code: "MODEL_NOT_FOUND",
          nodeId: node.id,
          field,
          message: `model "${value}" (node ${node.id}.${field}) not found in available ${String(registryKey)} list`,
        });
      }
    }
  }
}

/** 连接形态但 outputIndex 越界（有 schema 时可检查 outputTypes 长度）——供上层增强使用 */
export function checkConnectionArity(
  graph: WorkflowGraph,
  schemas: NodeSchemaLookup,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const conn of extractConnections(graph)) {
    const def = schemas.get(graph.nodes[conn.fromNode]?.classType ?? "");
    if (def && def.outputTypes.length > 0 && conn.outputIndex >= def.outputTypes.length) {
      issues.push({
        severity: "error",
        code: "OUTPUT_INDEX_OUT_OF_RANGE",
        nodeId: conn.toNode,
        field: conn.inputName,
        message: `node ${conn.fromNode} has ${def.outputTypes.length} outputs; index ${conn.outputIndex} out of range`,
      });
    }
  }
  return issues;
}
