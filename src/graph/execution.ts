/**
 * 执行策略选择器（02_ARCHITECTURE.md §9、05 M4）。
 *
 * 规则：
 *   only primitive inputs changed → nodeInfoList（模板 + 参数覆盖）
 *   topology changed / class_type changed / 连接值变化 → full workflow
 *
 * 官方明确不建议通过 nodeInfoList 修改连接值（03 §4），
 * 因此 inputsChanged 中出现连接形态时强制 fullWorkflow。
 */
import { rhError } from "../errors.js";
import type { NodeInfoOverride } from "../clients/runninghub/schemas.js";
import type { WorkflowDiff } from "./types.js";

export type ExecutionMode = "nodeInfoList" | "fullWorkflow";

export function chooseExecutionMode(diff: WorkflowDiff): ExecutionMode {
  if (diff.topologyChanged) return "fullWorkflow";
  if (diff.classTypesChanged) return "fullWorkflow";
  // 连接值变化（即使不构成拓扑增删）也必须走 full workflow
  if (diff.inputsChanged.some((c) => isConnectionLike(c.before) || isConnectionLike(c.after))) {
    return "fullWorkflow";
  }
  if (diff.inputsChanged.length === 0) return "nodeInfoList";
  return "nodeInfoList";
}

/**
 * 把参数级 diff 转换为 nodeInfoList。
 * @throws RhError(UNSUPPORTED) 当 diff 包含拓扑或连接变化时——调用方应先走 fullWorkflow 路径。
 */
export function graphChangesToNodeInfoList(diff: WorkflowDiff): NodeInfoOverride[] {
  const mode = chooseExecutionMode(diff);
  if (mode !== "nodeInfoList") {
    throw rhError(
      "UNSUPPORTED",
      "diff contains topology or connection changes; nodeInfoList cannot express them — use full workflow JSON",
      { reason: diff.topologyChanged ? "topologyChanged" : "connectionValueChanged" },
    );
  }
  return diff.inputsChanged.map((c) => ({
    nodeId: c.nodeId,
    fieldName: c.field,
    // chooseExecutionMode 已保证此处 after 是 primitive JSON 值（连接变化已走 fullWorkflow）
    fieldValue: (c.after ?? null) as NodeInfoOverride["fieldValue"],
  }));
}

function isConnectionLike(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    Number.isInteger(value[1])
  );
}
