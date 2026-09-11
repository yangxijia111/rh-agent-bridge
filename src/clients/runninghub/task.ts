/**
 * Task API（03_RUNNINGHUB_API_REFERENCE.md §5-§8，以 2026-09-11 官方文档为准）。
 *
 * POST /task/openapi/create  — 提交任务（nodeInfoList 或完整 workflow）
 * POST /task/openapi/outputs — 查询输出；code: 0=成功 / 804=运行中 / 805=失败
 * POST /task/openapi/status  — 辅助状态源（官方维护度低，不作为唯一判定）
 *
 * create task 默认禁止自动重试，避免重复生成和重复收费（硬性要求）。
 */
import { RhApiError, RhError } from "../../errors.js";
import type { RequestContext } from "./client.js";
import {
  createTaskDataSchema,
  nodeInfoOverrideSchema,
  promptTipsSchema,
  taskFailedReasonSchema,
  taskOutputItemSchema,
  taskStatusDataSchema,
  type NodeInfoOverride,
  type PromptTips,
} from "./schemas.js";

export interface CreateTaskInput {
  workflowId: string;
  /** 参数覆盖（仅限已有节点上的字段值，不得用于连接） */
  nodeInfoList?: NodeInfoOverride[];
  /** 完整 workflow JSON 字符串（拓扑修改时使用，覆盖 workflowId 对应内容） */
  workflow?: string;
  addMetadata?: boolean;
  webhookUrl?: string;
  instanceType?: string;
  usePersonalQueue?: boolean;
  accessPassword?: string;
}

export interface CreateTaskResult {
  taskId: string;
  taskStatus?: string;
  clientId?: string | null;
  netWssUrl?: string | null;
  /** 已解析的服务端校验结果 */
  promptTips?: PromptTips;
}

export type TaskState = "SUCCEEDED" | "RUNNING" | "FAILED" | "QUEUED" | "UNKNOWN";

export interface TaskOutput {
  url: string;
  type: string;
  nodeId?: string;
  costTimeSeconds?: number;
}

export interface TaskOutputsResult {
  state: TaskState;
  outputs: TaskOutput[];
  /** FAILED 时官方返回的 failedReason（结构化异常信息） */
  failedReason?: Record<string, unknown>;
  /** 非成功态时的原始提示 */
  msg?: string;
  /** UNKNOWN 态对应的业务码（P0.1-08：wait 层据此计数升级） */
  apiCode?: number;
  /** P0.1.1：仅展示提示（如 msg 含 queue/running），不参与状态机判定 */
  displayHint?: "QUEUED" | "RUNNING";
}

/** outputs 接口的业务状态码（官方 2026-09） */
const CODE_RUNNING = 804; // APIKEY_TASK_IS_RUNNING
const CODE_STATUS_ERROR = 805; // APIKEY_TASK_STATUS_ERROR
/** 任务不存在 / 过期等终态错误（不再轮询） */
const CODE_TASK_NOT_EXIST = 801;
const CODE_TASK_EXPIRE = 802;
const CODE_TASK_CANCEL = 813;
const TERMINAL_API_CODES = new Set([CODE_TASK_NOT_EXIST, CODE_TASK_EXPIRE, CODE_TASK_CANCEL]);
/**
 * P0.1-08：已确认的 transient 业务码（继续轮询）。
 * 目前官方文档明确枚举的只有 804（运行中）；
 * 排队态尚未见到官方明确 code，先只含 804，新确认后加入。
 */
const TRANSIENT_API_CODES = new Set([CODE_RUNNING]);

export class TaskApi {
  constructor(private readonly ctx: RequestContext) {}

  /**
   * 提交任务。
   * 不可幂等：client 层已关闭自动重试（allowRetry 缺省 false）。
   */
  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    if (input.nodeInfoList) {
      for (const item of input.nodeInfoList) nodeInfoOverrideSchema.parse(item);
    }
    const body: Record<string, unknown> = {
      apiKey: this.ctx.apiKey,
      workflowId: input.workflowId,
    };
    if (input.nodeInfoList !== undefined) body.nodeInfoList = input.nodeInfoList;
    if (input.workflow !== undefined) body.workflow = input.workflow;
    if (input.addMetadata !== undefined) body.addMetadata = input.addMetadata;
    if (input.webhookUrl !== undefined) body.webhookUrl = input.webhookUrl;
    if (input.instanceType !== undefined) body.instanceType = input.instanceType;
    if (input.usePersonalQueue !== undefined) body.usePersonalQueue = input.usePersonalQueue;
    if (input.accessPassword !== undefined) body.accessPassword = input.accessPassword;

    const data = await this.ctx.request(
      { method: "POST", path: "/task/openapi/create", body, allowRetry: false },
      (raw) => createTaskDataSchema.parse(raw ?? {}),
    );

    const promptTips = data.promptTips ? parsePromptTips(data.promptTips) : undefined;
    return {
      taskId: data.taskId,
      taskStatus: data.taskStatus ?? undefined,
      clientId: data.clientId ?? null,
      netWssUrl: data.netWssUrl ?? null,
      promptTips,
    };
  }

  /**
   * 查询任务输出与状态。
   * 以 outputs 为主要完成判定来源（官方建议），/status 仅辅助。
   */
  async getTaskOutputs(taskId: string): Promise<TaskOutputsResult> {
    try {
      const data = await this.ctx.request(
        {
          method: "POST",
          path: "/task/openapi/outputs",
          body: { apiKey: this.ctx.apiKey, taskId },
          allowRetry: true,
        },
        (raw) => raw,
      );
      return mapOutputsSuccess(data);
    } catch (err) {
      if (err instanceof RhApiError) {
        if (TRANSIENT_API_CODES.has(err.apiCode)) {
          return { state: "RUNNING", outputs: [], msg: err.message };
        }
        if (err.apiCode === CODE_STATUS_ERROR) {
          const rawFailed = err.details?.data as Record<string, unknown> | undefined;
          const failedReason =
            rawFailed && typeof rawFailed === "object" && "failedReason" in rawFailed
              ? (taskFailedReasonSchema.parse(rawFailed.failedReason) as Record<string, unknown>)
              : undefined;
          return { state: "FAILED", outputs: [], msg: err.message, failedReason };
        }
        if (TERMINAL_API_CODES.has(err.apiCode)) {
          throw err; // 801/802/813 等终态：立即失败
        }
        // P0.1.1 Fix 1：未知业务码一律标记 UNKNOWN（带 apiCode），由 TaskService.wait
        // 的 unknownBusinessCodeCount 决定是否升级 UNKNOWN_API_STATE。
        // 业务码判定优先于字符串推断——msg 含 queue/running 不得把 UNKNOWN 改写成
        // QUEUED/RUNNING（否则 unknown counter 被重置，可能轮询到超时）。
        // 字符串推断仅保留为展示提示字段 displayHint。
        return {
          state: "UNKNOWN",
          outputs: [],
          msg: err.message,
          apiCode: err.apiCode,
          ...(inferQueued(err) ? { displayHint: "QUEUED" } : {}),
        };
      }
      throw err;
    }
  }

  /** 辅助状态源（不作为唯一完成判定） */
  async getTaskStatus(taskId: string): Promise<{ taskStatus?: string; raw: unknown }> {
    const data = await this.ctx.request(
      {
        method: "POST",
        path: "/task/openapi/status",
        body: { apiKey: this.ctx.apiKey, taskId },
        allowRetry: true,
      },
      (raw) => taskStatusDataSchema.parse(raw ?? {}),
    );
    return { taskStatus: data.taskStatus ?? undefined, raw: data };
  }
}

function parsePromptTips(raw: string): PromptTips {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // promptTips 解析失败不阻断任务创建，但显式标记无效
    return { result: false, error: `unparseable promptTips: ${String(raw).slice(0, 200)}`, outputs_to_execute: [], node_errors: {} };
  }
  return promptTipsSchema.parse(parsed);
}

function mapOutputsSuccess(data: unknown): TaskOutputsResult {
  if (!Array.isArray(data)) {
    return { state: "UNKNOWN", outputs: [], msg: "outputs data is not an array" };
  }
  const outputs: TaskOutput[] = [];
  for (const item of data) {
    const parsed = taskOutputItemSchema.parse(item);
    outputs.push({
      url: parsed.fileUrl,
      type: parsed.fileType ?? "",
      nodeId: parsed.nodeId ?? undefined,
      costTimeSeconds: normalizeCostTime(parsed.taskCostTime),
    });
  }
  return { state: "SUCCEEDED", outputs };
}

function inferQueued(err: RhError): boolean {
  // P0.1.1：仅作 displayHint 展示辅助，不参与状态机判定。
  // 词边界匹配避免把 "RunningHub API error ..." 中的 "runninghub" 误判为 running。
  const msg = err.message.toLowerCase();
  return /\b(queued|queue|running)\b/.test(msg);
}

/**
 * P0.1-06：官方 taskCostTime 可能是 "83"（字符串）或 83（数字）。
 * 统一 normalize 为 finite number；无法转换 → undefined（不向 Agent 泄露 NaN）。
 */
function normalizeCostTime(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
