/**
 * BrowserFallbackService（02 §10、05 M8 host 模式）。
 *
 * 职责：
 *  1. 识别 API 无法表达的操作（前端-only 字段等，AT-401）；
 *  2. 构造 fallback 请求前强制保存 workflow snapshot（AT-402）；
 *  3. 通过 HostBrowserAdapter 输出结构化目标（AT-403：语义 goal，非坐标）。
 */
import type { RunningHubClient } from "../clients/runninghub/client.js";
import type { Logger } from "../config/logger.js";
import type { BrowserFallbackRequest, FallbackReason } from "../browser/types.js";
import { HostBrowserAdapter } from "../browser/host-adapter.js";
import { serializeApiFormat } from "../graph/serialize.js";
import type { SnapshotStore } from "./snapshots.js";

/** 官方文档明确的前端-only 字段（03 §4：API Format 中不存在或不具执行语义） */
export const FRONTEND_ONLY_FIELDS = new Set([
  "control_after_generate",
  "group",
  "group_id",
  "collapsed",
  "mode",
]);

export interface FallbackRequestInput {
  workflowId: string;
  goal: string;
  reason?: FallbackReason;
  context?: Record<string, unknown>;
  /** 已 fetch 的原始 API Format（省去再次请求） */
  rawApiFormat?: Record<string, unknown>;
  /** 已解析的本地 graph（serialize 后作为 snapshot；不触发任何网络请求） */
  graph?: import("../graph/types.js").WorkflowGraph;
}

export class BrowserFallbackService {
  constructor(
    private readonly rh: RunningHubClient,
    private readonly snapshots: SnapshotStore,
    private readonly adapter: HostBrowserAdapter,
    private readonly logger?: Logger,
  ) {}

  /** 判断字段是否前端-only（patch 工具用它提前转向浏览器路径） */
  isFrontendOnlyField(field: string): boolean {
    return FRONTEND_ONLY_FIELDS.has(field);
  }

  /**
   * 生成 browser fallback 请求。
   * snapshot 保存失败 → 抛错（AT-402：不得在无快照时继续浏览器变更）。
   * 优先使用调用方提供的 rawApiFormat / graph（本地快照，不发网络请求）。
   */
  async request(input: FallbackRequestInput): Promise<BrowserFallbackRequest> {
    const raw =
      input.rawApiFormat ??
      (input.graph !== undefined
        ? serializeApiFormat(input.graph)
        : await this.rh.workflow.getJsonApiFormat(input.workflowId));
    const snapshot = await this.snapshots.saveWorkflowSnapshot(input.workflowId, raw);
    this.logger?.info("snapshot saved before browser fallback", {
      workflowId: input.workflowId,
      snapshotPath: snapshot.filePath,
    });
    return this.adapter.buildFallback({
      workflowId: input.workflowId,
      goal: input.goal,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      snapshot: { filePath: snapshot.filePath, savedAt: snapshot.savedAt },
    });
  }
}
