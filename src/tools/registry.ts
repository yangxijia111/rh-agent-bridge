/**
 * 工具注册表：CLI 与 MCP 共用的唯一工具入口（05 M6：不允许各写一套业务逻辑）。
 * description 按 04 §19 写成"可决策描述"。
 */
import { z } from "zod";
import type { BridgeContext } from "../services/context.js";
import { doctorInputSchema, doctorTool } from "./doctor.js";
import {
  workflowDiffInputSchema,
  workflowDiffTool,
  workflowFetchInputSchema,
  workflowFetchTool,
  workflowInspectInputSchema,
  workflowInspectTool,
  workflowPatchInputSchema,
  workflowPatchTool,
  workflowRunInputSchema,
  workflowRunTool,
  workflowValidateInputSchema,
  workflowValidateTool,
} from "./workflow-tools.js";
import {
  taskOutputsInputSchema,
  taskOutputsTool,
  taskWaitInputSchema,
  taskWaitTool,
} from "./task-tools.js";
import { resourceUploadInputSchema, resourceUploadTool } from "./resource-tools.js";
import {
  nodeSearchInputSchema,
  nodeSearchTool,
  nodesProbeInputSchema,
  nodesProbeTool,
} from "./nodes-tools.js";
import {
  browserFallbackRequestInputSchema,
  browserFallbackRequestTool,
} from "./browser-tools.js";

export interface ToolInvokeExtra {
  /** MCP cancellation / CLI abort 透传 */
  signal?: AbortSignal;
}

export interface ToolEntry {
  name: string;
  description: string;
  /** 幂等性标记（04 §18）：description 中也向 Agent 声明 */
  idempotent: boolean;
  schema: z.ZodType<unknown>;
  handler: (ctx: BridgeContext, input: unknown, extra?: ToolInvokeExtra) => Promise<unknown>;
}

function entry<I extends z.ZodType<unknown>>(
  name: string,
  description: string,
  idempotent: boolean,
  schema: I,
  handler: (
    ctx: BridgeContext,
    input: z.infer<I>,
    extra?: ToolInvokeExtra,
  ) => Promise<unknown>,
): ToolEntry {
  return {
    name,
    description,
    idempotent,
    schema,
    handler: handler as (
      ctx: BridgeContext,
      input: unknown,
      extra?: ToolInvokeExtra,
    ) => Promise<unknown>,
  };
}

export const TOOL_REGISTRY: ToolEntry[] = [
  entry(
    "rh_doctor",
    "Check bridge configuration (API key presence) and optionally probe RunningHub Native ComfyUI capabilities (/features, /object_info, /models). Idempotent. Run this first to verify the environment.",
    true,
    doctorInputSchema,
    doctorTool,
  ),
  entry(
    "rh_workflow_fetch",
    "Fetch a RunningHub ComfyUI workflow in API Format by workflowId and return a structured graph (nodes, classType, inputs, connections). Use this before browser interaction when the user wants to inspect or modify a RunningHub workflow. Idempotent.",
    true,
    workflowFetchInputSchema,
    workflowFetchTool,
  ),
  entry(
    "rh_workflow_inspect",
    "List workflow nodes with id/classType/title/inputs/connections, optionally filtered by a classType-or-title query. Accepts a graph (from rh_workflow_fetch) or a workflowId. Idempotent.",
    true,
    workflowInspectInputSchema,
    workflowInspectTool,
  ),
  entry(
    "rh_workflow_diff",
    "Compare two workflow graphs (before/after) and report nodesAdded, nodesRemoved, connectionsAdded, connectionsRemoved, inputsChanged. Idempotent.",
    true,
    workflowDiffInputSchema,
    workflowDiffTool,
  ),
  entry(
    "rh_workflow_patch",
    "Patch node values or graph topology in a RunningHub API-format workflow without using browser UI: set_input, add_node, remove_node, connect, disconnect. Returns the new graph, a diff, validation results and the recommended execution mode (nodeInfoList vs full workflow). Frontend-only fields (e.g. control_after_generate) automatically return a browser fallback request instead. Does not submit any task. Idempotent.",
    true,
    workflowPatchInputSchema,
    workflowPatchTool,
  ),
  entry(
    "rh_workflow_validate",
    "Statically validate a workflow graph: broken references, cycles, output nodes, and (with useNodeSchema) node class existence and input types against the live /object_info catalog. Idempotent.",
    true,
    workflowValidateInputSchema,
    workflowValidateTool,
  ),
  entry(
    "rh_workflow_run",
    "Submit a RunningHub task. NOT idempotent (costs credits): each call creates one task, never auto-retried. Parameter mode: workflowId + overrides (nodeInfoList). Full-workflow mode: workflowId + graph (required after any topology change). Returns taskId and parsed promptTips validation.",
    false,
    workflowRunInputSchema,
    workflowRunTool,
  ),
  entry(
    "rh_task_outputs",
    "Fetch current outputs and state for a RunningHub taskId (SUCCEEDED with file URLs / RUNNING / FAILED with failedReason). Idempotent.",
    true,
    taskOutputsInputSchema,
    taskOutputsTool,
  ),
  entry(
    "rh_task_wait",
    "Poll a RunningHub taskId until it finishes (or timeoutMs elapses), then return its outputs. Blocks for the whole task duration (default 5 min). Returns FAILED with structured error if the task failed. Idempotent read pattern.",
    true,
    taskWaitInputSchema,
    taskWaitTool,
  ),
  entry(
    "rh_resource_upload",
    "Upload an image/audio/video/zip file (max 30MB) to RunningHub and return the fileName relative path to feed load nodes (e.g. LoadImage.image fieldValue). NOT idempotent (server-side file is created). The fileName is never a public URL.",
    false,
    resourceUploadInputSchema,
    resourceUploadTool,
  ),
  entry(
    "rh_nodes_probe",
    "Probe RunningHub Native ComfyUI endpoints (/features, /object_info, /models), build the node catalog and report capabilities. Cached ~10 min; pass refresh=true to force reload. Idempotent.",
    true,
    nodesProbeInputSchema,
    nodesProbeTool,
  ),
  entry(
    "rh_node_search",
    "Search the live node catalog (from /object_info) by class type, display name, category or keywords, e.g. 'remove background', 'upscale', 'lora'. Only real node classes are returned; never invents node names. Idempotent.",
    true,
    nodeSearchInputSchema,
    nodeSearchTool,
  ),
  entry(
    "rh_browser_fallback_request",
    "Build a structured browser fallback request (goal, domain allowlist, pre/postconditions) for operations the RunningHub API cannot express, after saving a workflow snapshot. The host agent (not this bridge) performs the browser steps. Idempotent.",
    true,
    browserFallbackRequestInputSchema,
    browserFallbackRequestTool,
  ),
];

export function getTool(name: string): ToolEntry | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
