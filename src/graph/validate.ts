/**
 * 静态校验器（02_ARCHITECTURE.md §8 验证分层、01_PRD.md FR-05、P0.1-02/P0.1-10）。
 *
 * Level 0 JSON      — parseApiFormat 内完成
 * Level 1 graph     — 引用 / 自引用 / outputIndex / cycle / output node
 * Level 2 schema    — 需 object_info（nodeSchemas 提供；缺失时跳过）
 *        + 连接校验 — validateConnectionsAgainstSchema（P0.1-02）
 * Level 3 resource  — 模型名校验，优先级（P0.1-10）：
 *        object_info COMBO options → /models/{folder} → 字段名 fallback
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
  /** folder（checkpoints/loras/vae/upscale_models）→ 模型文件列表（来自 /models/{folder}） */
  folders?: Record<string, string[]>;
  /** 字段名 fallback 映射（无法从 schema/combo 获取时的兜底） */
  byField?: Record<string, string[]>;
}

export interface ValidateOptions {
  nodeSchemas?: NodeSchemaLookup;
  models?: ModelRegistry;
  /** 是否把 Level 3 模型未命中升级为 error（默认 warning，模型列表可能不完整） */
  strictModels?: boolean;
}

/** 常见模型字段名 → folder 的 fallback 映射（P0.1-10：仅作最后兜底） */
const MODEL_FIELD_TO_FOLDER: Record<string, string> = {
  ckpt_name: "checkpoints",
  checkpoint_name: "checkpoints",
  lora_name: "loras",
  vae_name: "vae",
  upscale_model: "upscale_models",
};

/**
 * 已知 ComfyUI 连接类型集合（P0.1-02-E）：
 * 双方都是已知类型时严格比较；涉及未知 custom 类型时降级 warning，避免误报。
 */
const KNOWN_CONNECTION_TYPES = new Set([
  "MODEL",
  "CLIP",
  "VAE",
  "LATENT",
  "IMAGE",
  "MASK",
  "CONDITIONING",
  "CONTROL_NET",
  "SAMPLER",
  "SIGMAS",
  "UPSCALE_MODEL",
  "CLIP_VISION",
  "CLIP_VISION_OUTPUT",
  "STYLE_MODEL",
  "GLIGEN",
  "PHOTOMAKER",
]);

/** 已知 primitive 类型（不可作为连接目标 input） */
const PRIMITIVE_TYPES = new Set(["STRING", "INT", "FLOAT", "BOOLEAN", "COMBO"]);

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
    // P0.1-02：连接五要素校验（A 上游存在 / B 下游存在 / C outputIndex / D 连接型 input / E 类型兼容）
    issues.push(...validateConnectionsAgainstSchema(graph, schemas));
  } else {
    issues.push({
      severity: "warning",
      code: "SCHEMA_UNAVAILABLE",
      message: "object_info unavailable; only structural (Level 1) validation was performed",
    });
  }

  /* -------- Level 3：model / resource（P0.1-10 优先级） -------- */
  if (options.models) {
    validateModels(graph, options.models, options.nodeSchemas, options.strictModels ?? false, issues);
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
  if (connected) {
    // 连接值的合法性由 validateConnectionsAgainstSchema 统一判定（P0.1-02/P0.1.1），
    // 这里只拦截“连接型字段的常量”反例
    return;
  }
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

/* ---------------- P0.1-02：连接 schema 校验 ---------------- */

/**
 * 有 object_info schema 时对每条连接做校验：
 *  A. fromNode 存在（Level 1 通常已报 MISSING_UPSTREAM_NODE；这里以 schema 路径再确认，保持函数自洽）
 *  B. toNode 存在
 *  C. outputIndex < 上游 outputTypes.length → 否则 OUTPUT_INDEX_OUT_OF_RANGE
 *  D+E. 统一兼容性路径（P0.1.1）：
 *     sourceType === targetType → PASS（含 primitive 同类型，ComfyUI widget-convert 合法）
 *     双方类型明确且不同 → CONNECTION_TYPE_MISMATCH
 *     COMBO 的 socket 类型 / 未知 custom datatype 无法可靠判断 → UNKNOWN_TYPE_COMPAT warning
 */
export function validateConnectionsAgainstSchema(
  graph: WorkflowGraph,
  schemas: NodeSchemaLookup,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const conn of extractConnections(graph)) {
    // A. 上游节点存在（Level 1 通常已报 MISSING_UPSTREAM_NODE；这里避免二次误报类型错误）
    const fromNode = graph.nodes[conn.fromNode];
    if (!fromNode) continue;
    // B. 下游节点存在（extractConnections 的 toNode 来自节点自身，天然存在；防御性保留）
    const toNode = graph.nodes[conn.toNode];
    if (!toNode) continue;

    const fromDef = schemas.get(fromNode.classType);
    const toDef = schemas.get(toNode.classType);

    // C. outputIndex 越界
    if (fromDef && fromDef.outputTypes.length > 0 && conn.outputIndex >= fromDef.outputTypes.length) {
      issues.push({
        severity: "error",
        code: "OUTPUT_INDEX_OUT_OF_RANGE",
        nodeId: conn.toNode,
        field: conn.inputName,
        message: `node ${conn.fromNode} (${fromNode.classType}) has ${fromDef.outputTypes.length} outputs; index ${conn.outputIndex} out of range`,
      });
      continue;
    }

    if (!toDef) continue; // 下游类未知已在 Level 2 报 NODE_NOT_FOUND
    const targetSpec: NodeInputSpec | undefined =
      toDef.inputRequired[conn.inputName] ?? toDef.inputOptional[conn.inputName];

    // D+E 统一兼容性路径（P0.1.1 Fix 2）：
    // primitive/widget 类型输入同样允许由连接提供（ComfyUI widget-convert），
    // 不再因“目标是 primitive”一刀切拒绝；统一按 sourceType/targetType 判定：
    //   相同 → PASS；双方类型明确且不同 → mismatch error；无法可靠判断 → warning。
    const sourceType = fromDef?.outputTypes[conn.outputIndex];
    const targetType = targetSpec?.type;
    if (sourceType === undefined || targetType === undefined) continue;
    if (sourceType === targetType) continue; // 含 INT→INT / STRING→STRING 等 widget-convert 合法路径

    const details = {
      fromNode: conn.fromNode,
      outputIndex: conn.outputIndex,
      sourceType,
      toNode: conn.toNode,
      field: conn.inputName,
      targetType,
    };

    // COMBO 的真实 socket 类型当前 adapter 无法可靠判断（forceInput 等 metadata 未建模）→
    // warning，不得直接 error（完整建模留到 P0.2）
    if (sourceType === "COMBO" || targetType === "COMBO") {
      issues.push({
        severity: "warning",
        code: "UNKNOWN_TYPE_COMPAT",
        nodeId: conn.toNode,
        field: conn.inputName,
        message: `connection ${conn.fromNode}[${conn.outputIndex}] (${sourceType}) → ${conn.toNode}.${conn.inputName} (${targetType}) involves a COMBO whose socket type cannot be determined; compatibility not verified`,
        details,
      });
      continue;
    }

    const sourceKnown = KNOWN_CONNECTION_TYPES.has(sourceType) || PRIMITIVE_TYPES.has(sourceType);
    const targetKnown = KNOWN_CONNECTION_TYPES.has(targetType) || PRIMITIVE_TYPES.has(targetType);
    if (sourceKnown && targetKnown) {
      issues.push({
        severity: "error",
        code: "CONNECTION_TYPE_MISMATCH",
        nodeId: conn.toNode,
        field: conn.inputName,
        message: `connection ${conn.fromNode}[${conn.outputIndex}] (${sourceType}) → ${conn.toNode}.${conn.inputName} (${targetType}) type mismatch`,
        details,
      });
    } else {
      // custom datatype 无法判断 → warning（P0.1-02：优先于误报）
      issues.push({
        severity: "warning",
        code: "UNKNOWN_TYPE_COMPAT",
        nodeId: conn.toNode,
        field: conn.inputName,
        message: `connection ${conn.fromNode}[${conn.outputIndex}] (${sourceType}) → ${conn.toNode}.${conn.inputName} (${targetType}) involves a custom datatype; compatibility not verified`,
        details,
      });
    }
  }
  return issues;
}

/* ---------------- Level 3：模型校验（P0.1-10 优先级） ---------------- */

function validateModels(
  graph: WorkflowGraph,
  models: ModelRegistry,
  schemas: NodeSchemaLookup | undefined,
  strict: boolean,
  issues: ValidationIssue[],
): void {
  for (const node of Object.values(graph.nodes)) {
    const def = schemas?.get(node.classType);
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string") continue;

      // 优先级 1：object_info 该字段是 COMBO 且带 options → 直接用 options 作模型列表
      const spec = def ? (def.inputRequired[field] ?? def.inputOptional[field]) : undefined;
      if (spec && spec.type === "COMBO" && spec.options && spec.options.length > 0) {
        if (!spec.options.includes(value)) {
          issues.push(modelIssue(node.id, field, value, "object_info combo options", strict));
        }
        continue;
      }

      // 优先级 2：字段名 → folder（/models/{folder} 列表）；folder 数据缺失时才走优先级 3
      const folder = MODEL_FIELD_TO_FOLDER[field];
      if (folder) {
        const folderList = models.folders?.[folder];
        if (folderList && folderList.length > 0) {
          if (!folderList.includes(value)) {
            issues.push(modelIssue(node.id, field, value, `/models/${folder}`, strict));
          }
          continue; // folder 数据已覆盖该字段，不再用字段级 fallback
        }
      }

      // 优先级 3：调用方注入的字段级 fallback 列表
      const fallback = models.byField?.[field];
      if (fallback && fallback.length > 0 && !fallback.includes(value)) {
        issues.push(modelIssue(node.id, field, value, "field-name fallback", strict));
      }
    }
  }
}

function modelIssue(
  nodeId: string,
  field: string,
  value: string,
  source: string,
  strict: boolean,
): ValidationIssue {
  return {
    severity: strict ? "error" : "warning",
    code: "MODEL_NOT_FOUND",
    nodeId,
    field,
    message: `model "${value}" (node ${nodeId}.${field}) not found in ${source}`,
  };
}
