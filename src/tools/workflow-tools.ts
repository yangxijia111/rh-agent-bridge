/**
 * Workflow 工具集（04 §3/§4/§7/§9/§11/§14）。
 * 全部幂等（patch/validate/diff 不落远端状态）；run 除外。
 */
import { z } from "zod";
import { RhError } from "../errors.js";
import type { BridgeContext } from "../services/context.js";
import { graphFromUnknown, graphOperationSchema, nodeInfoOverrideInputSchema, workflowGraphJsonSchema } from "./schemas.js";

/* ---------------- rh_workflow_fetch ---------------- */

export const workflowFetchInputSchema = z.object({
  workflowId: z.string().min(1),
  includeRaw: z.boolean().optional().default(false),
});

export async function workflowFetchTool(
  ctx: BridgeContext,
  input: z.infer<typeof workflowFetchInputSchema>,
) {
  const result = await ctx.workflow.fetch(input.workflowId, { includeRaw: input.includeRaw });
  return {
    workflowId: result.workflowId,
    graph: result.graph,
    ...(result.rawApiFormat !== undefined ? { rawApiFormat: result.rawApiFormat } : {}),
  };
}

/* ---------------- rh_workflow_inspect ---------------- */

export const workflowInspectInputSchema = z.object({
  workflowId: z.string().min(1).optional(),
  graph: workflowGraphJsonSchema.optional(),
  query: z.string().optional(),
});

export async function workflowInspectTool(
  ctx: BridgeContext,
  input: z.infer<typeof workflowInspectInputSchema>,
) {
  if (input.graph === undefined && input.workflowId === undefined) {
    throw new RhError("CONFIG", "provide either workflowId or graph");
  }
  const graph =
    input.graph !== undefined
      ? graphFromUnknown(input.graph)
      : (await ctx.workflow.fetch(input.workflowId!)).graph;
  const { nodes } = ctx.workflow.inspect({ graph, query: input.query });
  return { nodes };
}

/* ---------------- rh_workflow_diff ---------------- */

export const workflowDiffInputSchema = z.object({
  before: z.unknown(),
  after: z.unknown(),
});

export async function workflowDiffTool(
  _ctx: BridgeContext,
  input: z.infer<typeof workflowDiffInputSchema>,
) {
  return _ctx.workflow.diff(graphFromUnknown(input.before), graphFromUnknown(input.after));
}

/* ---------------- rh_workflow_patch ---------------- */

export const workflowPatchInputSchema = z.object({
  workflowId: z.string().min(1).optional(),
  graph: workflowGraphJsonSchema.optional(),
  operations: z.array(graphOperationSchema).min(1),
  useNodeSchema: z.boolean().optional().default(false),
});

export async function workflowPatchTool(
  ctx: BridgeContext,
  input: z.infer<typeof workflowPatchInputSchema>,
) {
  if (input.graph === undefined && input.workflowId === undefined) {
    throw new RhError("CONFIG", "provide either workflowId or graph");
  }

  // 前端-only 字段：不伪造 API 写操作（AT-401），返回 browser fallback 建议。
  // P0.1-03：baseline 必须是远端当前态 → 必须 fetch remote（本地 graph 不可作 rollback 依据）。
  const frontendOnly = input.operations.filter(
    (op): op is SetInputOperationInput =>
      op.type === "set_input" && ctx.browserFallback.isFrontendOnlyField(op.field),
  );
  if (frontendOnly.length > 0) {
    if (input.workflowId === undefined) {
      throw new RhError(
        "CONFIG",
        "frontend-only field patch requires workflowId so the remote baseline can be snapshotted",
      );
    }
    const remoteRaw = await ctx.rh.workflow.getJsonApiFormat(input.workflowId);
    return ctx.browserFallback.request({
      workflowId: input.workflowId,
      goal: `Set frontend-only field(s) ${frontendOnly.map((op) => `${op.nodeId}.${op.field}`).join(", ")} in the RunningHub workflow editor`,
      reason: "FRONTEND_ONLY_FIELD",
      context: { operations: frontendOnly },
      rawApiFormat: remoteRaw,
    });
  }

  const baseGraph =
    input.graph !== undefined
      ? graphFromUnknown(input.graph)
      : (await ctx.workflow.fetch(input.workflowId!)).graph;

  const patched = await ctx.workflow.patch(
    { graph: baseGraph, operations: input.operations },
    { useNodeSchema: input.useNodeSchema },
  );
  return {
    graph: patched.graph,
    diff: patched.diff,
    warnings: patched.warnings,
    assignedNodeIds: patched.assignedNodeIds,
    validation: patched.validation,
    recommendedExecutionMode: patched.recommendedExecutionMode,
    ...(patched.nodeInfoList !== undefined ? { nodeInfoList: patched.nodeInfoList } : {}),
  };
}

/* ---------------- rh_workflow_validate ---------------- */

export const workflowValidateInputSchema = z.object({
  graph: z.unknown(),
  useNodeSchema: z.boolean().optional().default(true),
  checkModels: z.boolean().optional().default(false),
});

export async function workflowValidateTool(
  ctx: BridgeContext,
  input: z.infer<typeof workflowValidateInputSchema>,
) {
  const graph = graphFromUnknown(input.graph);
  const result = await ctx.workflow.validateGraph(graph, {
    useNodeSchema: input.useNodeSchema,
    checkModels: input.checkModels,
  });
  return result;
}

type PatchOperationInput = z.infer<typeof workflowPatchInputSchema>["operations"][number];
type SetInputOperationInput = Extract<PatchOperationInput, { type: "set_input" }>;

/* ---------------- rh_workflow_run ---------------- */

export const workflowRunInputSchema = z.object({
  workflowId: z.string().min(1),
  overrides: z.array(nodeInfoOverrideInputSchema).optional(),
  graph: workflowGraphJsonSchema.optional(),
  instanceType: z.enum(["standard", "plus"]).optional(),
  addMetadata: z.boolean().optional(),
  webhookUrl: z.string().url().optional(),
});

export async function workflowRunTool(
  ctx: BridgeContext,
  input: z.infer<typeof workflowRunInputSchema>,
) {
  if (input.graph === undefined && (input.overrides === undefined || input.overrides.length === 0)) {
    throw new RhError(
      "CONFIG",
      "provide either overrides (nodeInfoList mode) or graph (full workflow mode)",
    );
  }
  return ctx.workflow.run({
    workflowId: input.workflowId,
    ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
    ...(input.graph !== undefined ? { graph: graphFromUnknown(input.graph) } : {}),
    ...(input.instanceType !== undefined ? { instanceType: input.instanceType } : {}),
    ...(input.addMetadata !== undefined ? { addMetadata: input.addMetadata } : {}),
    ...(input.webhookUrl !== undefined ? { webhookUrl: input.webhookUrl } : {}),
  });
}
