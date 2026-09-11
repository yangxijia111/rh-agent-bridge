/**
 * RunningHub OpenAPI 响应 zod schemas（03_RUNNINGHUB_API_REFERENCE.md）。
 *
 * 所有外部响应必须经 zod 校验后再进入 domain。
 * 以 2026-09-11 官方文档为准：
 *  - /api/openapi/getJsonApiFormat
 *  - /task/openapi/create
 *  - /task/openapi/outputs
 *  - /task/openapi/status
 *  - /task/openapi/upload
 *  - /api/openapi/getLoraUploadUrl
 */
import { z } from "zod";

/** RunningHub 通用响应包装：code=0 成功，非 0 为业务错误 */
export const responseEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().default(""),
  data: z.unknown().optional(),
});

/** getJsonApiFormat 响应：data.prompt 是序列化的 workflow JSON 字符串 */
export const workflowApiFormatDataSchema = z.object({
  prompt: z.string(),
});

/** nodeInfoList 条目 */
export const nodeInfoOverrideSchema = z.object({
  nodeId: z.string(),
  fieldName: z.string(),
  // 官方 fieldValue 允许任意 JSON 值；连接形态（[nodeId, index]）不得经此通道覆盖（03 §4），
  // 该约束由 graph 层 execution.ts 把关
  fieldValue: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.unknown()),
    z.record(z.unknown()),
  ]),
});
export type NodeInfoOverride = z.infer<typeof nodeInfoOverrideSchema>;

/** promptTips 解析结果（ComfyUI 服务端校验） */
export const promptTipsSchema = z.object({
  result: z.boolean(),
  error: z.unknown().nullable(),
  outputs_to_execute: z.array(z.string()).default([]),
  node_errors: z.record(z.unknown()).default({}),
});
export type PromptTips = z.infer<typeof promptTipsSchema>;

/** create task 响应 data */
export const createTaskDataSchema = z.object({
  taskId: z.string(),
  taskStatus: z.string().optional(),
  clientId: z.string().nullish(),
  netWssUrl: z.string().nullish(),
  promptTips: z.string().nullish(),
});

/** outputs 成功时的单个输出条目 */
export const taskOutputItemSchema = z.object({
  fileUrl: z.string(),
  fileType: z.string().nullish(),
  taskCostTime: z.string().nullish(),
  nodeId: z.string().nullish(),
  thirdPartyConsumeMoney: z.unknown().nullish(),
  consumeMoney: z.unknown().nullish(),
  consumeCoins: z.string().nullish(),
});

/** outputs 805 失败时的 failedReason */
export const taskFailedReasonSchema = z
  .object({
    node_name: z.string().nullish(),
    node_id: z.string().nullish(),
    exception_type: z.string().nullish(),
    exception_message: z.string().nullish(),
    traceback: z.string().nullish(),
  })
  .passthrough();

/** upload 响应 data：fileName 是相对路径，严禁拼成公共 URL */
export const uploadDataSchema = z.object({
  fileName: z.string(),
  fileType: z.string().nullish(),
});

/** getLoraUploadUrl 响应 data：url 是一次性 signed upload url，禁止入长期日志 */
export const loraUploadDataSchema = z.object({
  fileName: z.string(),
  url: z.string(),
});

/** status 响应 data（官方维护度低，宽松解析） */
export const taskStatusDataSchema = z
  .object({
    taskStatus: z.string().nullish(),
    failedReason: z.unknown().optional(),
  })
  .passthrough();
