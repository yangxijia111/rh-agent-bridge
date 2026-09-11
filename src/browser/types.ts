/**
 * Browser fallback 类型（02_ARCHITECTURE.md §10）。
 *
 * host 模式：bridge 只输出结构化操作建议，宿主智能体（Codex/Zcode）
 * 用自身 Browser / Computer Use 能力执行。MVP 只实现 host。
 */

export type FallbackReason =
  | "FRONTEND_ONLY_FIELD"
  | "UI_LAYOUT_OR_GROUP"
  | "API_CAPABILITY_MISSING"
  | "AUTH_OR_DOWNLOAD_FLOW"
  | "NATIVE_PROBE_FAILED";

export interface BrowserFallbackRequest {
  requiresBrowser: true;
  mode: "host" | "cdp";
  reason: FallbackReason;
  /** 结构化目标（语义描述，不是像素坐标，AT-403） */
  goal: string;
  /** 建议技术优先级：DOM → CDP → vision */
  strategy: Array<"DOM" | "CDP" | "vision">;
  domainAllowlist: string[];
  preconditions: string[];
  postconditions: string[];
  context?: Record<string, unknown>;
}

export interface BrowserFallbackContext {
  workflowId: string;
  goal: string;
  reason?: FallbackReason;
  context?: Record<string, unknown>;
  /** browser mutation 前已保存的 snapshot（由 service 强制生成） */
  snapshot?: { filePath: string; savedAt: string };
}
