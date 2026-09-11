/**
 * WorkflowService：fetch / inspect / patch / validate / diff / run（04_TOOL_AND_MCP_SPEC）。
 *
 * run 的两种模式（FR-06）：
 *  - 参数覆盖：workflowId + nodeInfoList
 *  - 拓扑修改：workflowId + workflow=<完整 JSON string>
 *
 * P0.1-03：full workflow run 的快照语义——
 *   fetch remote → save baseline（远端当前态，rollback 依据）
 *   → serialize candidate → 可选 save candidate → submit。
 *   baseline 绝不是即将提交的候选 graph。
 *
 * P0.1-04：nodeInfoList 保护下沉到 Service boundary——
 *   connection-like 值与前端-only 字段在任何入口（tool/CLI/MCP 直调）都被拦截。
 */
import type { NodeCatalogService } from "../catalog/cache.js";
import { LEVEL3_MODEL_FOLDERS } from "../catalog/cache.js";
import type { RunningHubClient } from "../clients/runninghub/client.js";
import type { NodeInfoOverride, PromptTips } from "../clients/runninghub/schemas.js";
import type { Logger } from "../config/logger.js";
import { RhError, rhError } from "../errors.js";
import { isFrontendOnlyField } from "../graph/frontend-only-fields.js";
import { chooseExecutionMode, graphChangesToNodeInfoList } from "../graph/execution.js";
import { diffGraphs } from "../graph/diff.js";
import { findNodes, listNodes } from "../graph/inspect.js";
import { patchGraph } from "../graph/mutate.js";
import { parseApiFormat } from "../graph/parse.js";
import { serializeApiFormat } from "../graph/serialize.js";
import type {
  GraphOperation,
  ValidationIssue,
  WorkflowDiff,
  WorkflowGraph,
} from "../graph/types.js";
import { validateGraph, type ModelRegistry } from "../graph/validate.js";
import type { SnapshotStore } from "./snapshots.js";

export interface WorkflowFetchResult {
  workflowId: string;
  graph: WorkflowGraph;
  rawApiFormat?: Record<string, unknown>;
}

export interface WorkflowPatchOutput {
  graph: WorkflowGraph;
  diff: WorkflowDiff;
  warnings: ValidationIssue[];
  assignedNodeIds: Record<string, string>;
  validation: { valid: boolean; issues: ValidationIssue[] };
  recommendedExecutionMode: "nodeInfoList" | "fullWorkflow";
  /** 拓扑路径下的 nodeInfoList 等价物（官方 03 §4：连接不可用 nodeInfoList 表达） */
  nodeInfoList?: NodeInfoOverride[];
}

export interface WorkflowRunInput {
  workflowId: string;
  /** 参数覆盖模式（模板 + nodeInfoList） */
  overrides?: NodeInfoOverride[];
  /** 完整 graph 模式（serialize 后走 workflow 字段） */
  graph?: WorkflowGraph;
  instanceType?: string;
  addMetadata?: boolean;
  webhookUrl?: string;
}

export interface WorkflowRunResult {
  taskId: string;
  status?: string;
  executionMode: "nodeInfoList" | "fullWorkflow";
  /** P0.1-03：本次运行的快照记录（baseline=远端旧态；candidate=已提交候选态） */
  snapshots?: {
    baseline: { filePath: string; savedAt: string };
    candidate?: { filePath: string; savedAt: string };
  };
  validation: {
    valid: boolean;
    error?: string;
    nodeErrors: Record<string, unknown>;
    outputsToExecute: string[];
  };
}

export interface WorkflowValidateOptions {
  useNodeSchema?: boolean;
  checkModels?: boolean;
}

export class WorkflowService {
  constructor(
    private readonly rh: RunningHubClient,
    private readonly catalog: NodeCatalogService,
    private readonly snapshots: SnapshotStore,
    private readonly logger?: Logger,
  ) {}

  async fetch(workflowId: string, options: { includeRaw?: boolean } = {}): Promise<WorkflowFetchResult> {
    const raw = await this.rh.workflow.getJsonApiFormat(workflowId);
    const graph = parseApiFormat(raw);
    return {
      workflowId,
      graph,
      ...(options.includeRaw ? { rawApiFormat: raw } : {}),
    };
  }

  inspect(input: { graph: WorkflowGraph; query?: string }) {
    const nodes =
      input.query !== undefined && input.query !== ""
        ? findNodes(input.graph, input.query)
        : listNodes(input.graph);
    return { nodes };
  }

  /**
   * patch（04 §7）：graph + operations → 新 graph / diff / 校验 / 推荐执行模式。
   * 默认带结构校验；useNodeSchema 时用 catalog（object_info）做 Level 2 + 连接校验。
   */
  async patch(
    input: { graph: WorkflowGraph; operations: GraphOperation[] },
    options: WorkflowValidateOptions = {},
  ): Promise<WorkflowPatchOutput> {
    const result = patchGraph(input.graph, input.operations);
    const validation = await this.validateGraph(result.graph, options);
    const recommendedExecutionMode = chooseExecutionMode(result.diff);
    const output: WorkflowPatchOutput = {
      graph: result.graph,
      diff: result.diff,
      warnings: result.warnings,
      assignedNodeIds: result.assignedNodeIds,
      validation,
      recommendedExecutionMode,
    };
    if (recommendedExecutionMode === "nodeInfoList" && result.diff.inputsChanged.length > 0) {
      output.nodeInfoList = graphChangesToNodeInfoList(result.diff);
    }
    return output;
  }

  async validateGraph(
    graph: WorkflowGraph,
    options: WorkflowValidateOptions = {},
  ): Promise<{ valid: boolean; issues: ValidationIssue[] }> {
    let models: ModelRegistry | undefined;
    if (options.checkModels) {
      models = await this.buildModelRegistry();
    }
    return validateGraph(graph, {
      ...(options.useNodeSchema ? { nodeSchemas: this.catalog } : {}),
      ...(models !== undefined ? { models } : {}),
    });
  }

  /** P0.1-10：Level 3 数据源（/models/{folder} lazy 拉取；folder 缺失自动跳过） */
  private async buildModelRegistry(): Promise<ModelRegistry | undefined> {
    const folders: Record<string, string[]> = {};
    let any = false;
    for (const folder of LEVEL3_MODEL_FOLDERS) {
      const list = await this.catalog.getModelsByFolder(folder);
      if (list && list.length > 0) {
        folders[folder] = list;
        any = true;
      }
    }
    return any ? { folders } : undefined;
  }

  diff(before: WorkflowGraph, after: WorkflowGraph): WorkflowDiff {
    return diffGraphs(before, after);
  }

  /**
   * 执行 workflow（04 §11）。
   *
   * P0.1-04：任何入口的 overrides 先过 Service boundary 保护：
   *  - connection-like 值（["nodeId", index]）→ UNSUPPORTED（要求走 full workflow）
   *  - 前端-only 字段 → REQUIRES_BROWSER
   * P0.1-03：graph 模式先 fetch 远端存 baseline 快照，再提交 candidate。
   */
  async run(input: WorkflowRunInput): Promise<WorkflowRunResult> {
    if (input.overrides !== undefined && input.overrides.length > 0) {
      assertOverridesSafe(input.overrides);
    }

    let workflowJson: string | undefined;
    let snapshotRecords: WorkflowRunResult["snapshots"];
    if (input.graph !== undefined) {
      // P0.1-03：baseline 必须是 RunningHub 远端当前状态（rollback 依据），
      // 不是即将提交的候选 graph。
      const remoteRaw = await this.rh.workflow.getJsonApiFormat(input.workflowId);
      const baseline = await this.snapshots.saveWorkflowSnapshot(
        input.workflowId,
        "baseline",
        remoteRaw,
      );
      this.logger?.info("baseline snapshot saved before full-workflow run", {
        workflowId: input.workflowId,
        snapshotPath: baseline.filePath,
      });

      const serialized = serializeApiFormat(input.graph);
      workflowJson = JSON.stringify(serialized);
      const candidate = await this.snapshots.saveWorkflowSnapshot(
        input.workflowId,
        "candidate",
        serialized,
      );
      this.logger?.info("candidate snapshot saved", {
        workflowId: input.workflowId,
        snapshotPath: candidate.filePath,
      });
      snapshotRecords = {
        baseline: { filePath: baseline.filePath, savedAt: baseline.savedAt },
        candidate: { filePath: candidate.filePath, savedAt: candidate.savedAt },
      };
    }
    const created = await this.rh.task.createTask({
      workflowId: input.workflowId,
      ...(input.graph !== undefined ? { workflow: workflowJson } : {}),
      ...(input.overrides !== undefined && input.overrides.length > 0
        ? { nodeInfoList: input.overrides }
        : {}),
      ...(input.instanceType !== undefined ? { instanceType: input.instanceType } : {}),
      ...(input.addMetadata !== undefined ? { addMetadata: input.addMetadata } : {}),
      ...(input.webhookUrl !== undefined ? { webhookUrl: input.webhookUrl } : {}),
    });

    const tips: PromptTips | undefined = created.promptTips;
    const valid =
      tips === undefined ? true : tips.result === true && Object.keys(tips.node_errors).length === 0;
    return {
      taskId: created.taskId,
      status: created.taskStatus,
      executionMode: input.graph !== undefined ? "fullWorkflow" : "nodeInfoList",
      ...(snapshotRecords !== undefined ? { snapshots: snapshotRecords } : {}),
      validation: {
        valid,
        ...(tips?.error != null ? { error: stringifyError(tips.error) } : {}),
        nodeErrors: tips?.node_errors ?? {},
        outputsToExecute: tips?.outputs_to_execute ?? [],
      },
    };
  }
}

/**
 * P0.1-04：nodeInfoList 安全护栏（Service boundary，所有入口共用）。
 * @throws rhError(UNSUPPORTED)        connection-like 值进入 nodeInfoList
 * @throws rhError(REQUIRES_BROWSER)   前端-only 字段试图经 nodeInfoList 绕过
 */
function assertOverridesSafe(overrides: NodeInfoOverride[]): void {
  for (const override of overrides) {
    if (isConnectionLikeValue(override.fieldValue)) {
      throw rhError(
        "UNSUPPORTED",
        `nodeInfoList override ${override.nodeId}.${override.fieldName} carries a connection-like value ` +
          `[${String((override.fieldValue as unknown[])[0])}, ${(override.fieldValue as unknown[])[1]}]; ` +
          `connections cannot be expressed via nodeInfoList — use full workflow JSON`,
        { nodeId: override.nodeId, fieldName: override.fieldName },
      );
    }
    if (isFrontendOnlyField(override.fieldName)) {
      throw rhError(
        "REQUIRES_BROWSER",
        `nodeInfoList override ${override.nodeId}.${override.fieldName} targets a frontend-only field; ` +
          `it does not exist in API Format — use the browser fallback flow instead`,
        { nodeId: override.nodeId, fieldName: override.fieldName },
      );
    }
  }
}

function isConnectionLikeValue(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    Number.isInteger(value[1])
  );
}

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

export { RhError };
