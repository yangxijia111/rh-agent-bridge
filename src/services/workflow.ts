/**
 * WorkflowService：fetch / inspect / patch / validate / diff / run（04_TOOL_AND_MCP_SPEC）。
 *
 * run 的两种模式（FR-06）：
 *  - 参数覆盖：workflowId + nodeInfoList
 *  - 拓扑修改：workflowId + workflow=<完整 JSON string>，执行前保存 snapshot（05）
 */
import type { NodeCatalogService } from "../catalog/cache.js";
import type { RunningHubClient } from "../clients/runninghub/client.js";
import type { NodeInfoOverride, PromptTips } from "../clients/runninghub/schemas.js";
import type { Logger } from "../config/logger.js";
import { RhError } from "../errors.js";
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
    const nodes = input.query !== undefined && input.query !== "" ? findNodes(input.graph, input.query) : listNodes(input.graph);
    return { nodes };
  }

  /**
   * patch（04 §7）：graph + operations → 新 graph / diff / 校验 / 推荐执行模式。
   * 默认带结构校验；useNodeSchema 时用 catalog（object_info）做 Level 2。
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
      const raw = await this.catalog.getModels();
      if (raw) {
        models = {
          checkpoints: raw.checkpoints,
          loras: raw.loras ?? raw["loras"],
          vae: raw.vae,
          upscaleModels: raw.upscale_models,
        };
      }
    }
    return validateGraph(graph, {
      ...(options.useNodeSchema ? { nodeSchemas: this.catalog } : {}),
      ...(models !== undefined ? { models } : {}),
    });
  }

  diff(before: WorkflowGraph, after: WorkflowGraph): WorkflowDiff {
    return diffGraphs(before, after);
  }

  /**
   * 执行 workflow（04 §11）。
   * graph 模式执行前保存 snapshot；返回 promptTips 的结构化校验结果。
   */
  async run(input: WorkflowRunInput): Promise<WorkflowRunResult> {
    let workflowJson: string | undefined;
    if (input.graph !== undefined) {
      const serialized = serializeApiFormat(input.graph);
      workflowJson = JSON.stringify(serialized);
      const snap = await this.snapshots.saveWorkflowSnapshot(input.workflowId, serialized);
      this.logger?.info("workflow snapshot saved before full-workflow run", {
        workflowId: input.workflowId,
        snapshotPath: snap.filePath,
      });
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
      validation: {
        valid,
        ...(tips?.error != null ? { error: stringifyError(tips.error) } : {}),
        nodeErrors: tips?.node_errors ?? {},
        outputsToExecute: tips?.outputs_to_execute ?? [],
      },
    };
  }
}

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

export { RhError };
