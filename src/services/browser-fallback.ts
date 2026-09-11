/**
 * BrowserFallbackService（02 §10、05 M8 host 模式、P0.1-03 baseline 语义）。
 *
 * 职责：
 *  1. 识别 API 无法表达的操作（前端-only 字段等，AT-401）；
 *  2. 构造 fallback 请求前强制保存 baseline snapshot（AT-402）；
 *  3. 通过 HostBrowserAdapter 输出结构化目标（AT-403：语义 goal，非坐标）。
 *
 * P0.1-03：baseline 必须是远端当前 workflow（rollback 依据）。
 *  - 默认重新 fetch remote；
 *  - 调用方可传 rawApiFormat 显式声明「这就是我刚 fetch 的远端态」（trusted baseline），
 *    语义必须明确——Agent 本地修改过的 graph 不允许作为 baseline。
 */
import type { RunningHubClient } from "../clients/runninghub/client.js";
import type { Logger } from "../config/logger.js";
import { isFrontendOnlyField, FRONTEND_ONLY_FIELDS } from "../graph/frontend-only-fields.js";
import type { BrowserFallbackRequest, FallbackReason } from "../browser/types.js";
import { HostBrowserAdapter } from "../browser/host-adapter.js";
import type { SnapshotStore } from "./snapshots.js";

export interface FallbackRequestInput {
  workflowId: string;
  goal: string;
  reason?: FallbackReason;
  context?: Record<string, unknown>;
  /**
   * 可选的 trusted baseline：调用方刚 fetch 的远端 API Format 原始对象。
   * 传入即声明「这就是远端当前状态」，service 不再重复 fetch；
   * 不传则 service 自己 fetch remote 作为 baseline。
   */
  rawApiFormat?: Record<string, unknown>;
}

export class BrowserFallbackService {
  constructor(
    private readonly rh: RunningHubClient,
    private readonly snapshots: SnapshotStore,
    private readonly adapter: HostBrowserAdapter,
    private readonly logger?: Logger,
  ) {}

  /** 判断字段是否前端-only（patch / run 共用，P0.1-04 单一来源） */
  isFrontendOnlyField(field: string): boolean {
    return isFrontendOnlyField(field);
  }

  /**
   * 生成 browser fallback 请求。
   * baseline = 远端当前 workflow（P0.1-03）：默认 fetch remote，
   * 或使用调用方显式声明的 trusted rawApiFormat。
   * snapshot 保存失败 → 抛错（AT-402：不得在无快照时继续浏览器变更）。
   */
  async request(input: FallbackRequestInput): Promise<BrowserFallbackRequest> {
    const baselineRaw =
      input.rawApiFormat ?? (await this.rh.workflow.getJsonApiFormat(input.workflowId));
    const snapshot = await this.snapshots.saveWorkflowSnapshot(
      input.workflowId,
      "baseline",
      baselineRaw,
    );
    this.logger?.info("baseline snapshot saved before browser fallback", {
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

export { FRONTEND_ONLY_FIELDS };
