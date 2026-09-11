/**
 * host 模式 BrowserAdapter（02 §10、05 M8）。
 *
 * 不控制浏览器；只构造结构化 BrowserFallbackRequest，
 * 由 Codex / Zcode 等宿主智能体用自己的浏览器能力执行。
 * 输出必须是语义目标（goal），不是像素坐标（AT-403）。
 */
import type {
  BrowserFallbackContext,
  BrowserFallbackRequest,
} from "./types.js";

/** RunningHub 域名 allowlist（01 §8 安全要求：默认只允许 RunningHub 域） */
export const DEFAULT_DOMAIN_ALLOWLIST = ["runninghub.ai", "www.runninghub.ai"];

export class HostBrowserAdapter {
  readonly mode = "host" as const;

  buildFallback(context: BrowserFallbackContext): BrowserFallbackRequest {
    return {
      requiresBrowser: true,
      mode: "host",
      reason: context.reason ?? "API_CAPABILITY_MISSING",
      goal: context.goal,
      strategy: ["DOM", "CDP", "vision"],
      domainAllowlist: [...DEFAULT_DOMAIN_ALLOWLIST],
      preconditions: context.snapshot
        ? [`workflow snapshot saved at ${context.snapshot.filePath}`]
        : ["workflow snapshot saved (enforced by service before this request)"],
      postconditions: [
        "re-run rh_workflow_fetch to read the updated workflow",
        "calculate before/after diff with rh_workflow_diff",
        "abort and restore from snapshot if the change is unexpected",
      ],
      ...(context.context !== undefined ? { context: context.context } : {}),
    };
  }
}
