/**
 * 环境变量配置（01_PRD.md FR-01）。
 *
 * Domain 层禁止 import 本模块（05_IMPLEMENTATION_PLAN 代码设计要求）。
 * API key 只从这里读取，且永远不回显完整值。
 */
import { redactString } from "./redaction.js";

export interface BridgeConfig {
  /** RunningHub API key */
  apiKey: string;
  /** OpenAPI base url，默认 https://www.runninghub.ai */
  baseUrl: string;
  /** 默认 workflow id（可为空） */
  defaultWorkflowId?: string;
  /** Native ComfyUI 代理模式：standard | plus */
  nativeMode: "standard" | "plus";
  /** 浏览器兜底模式：host | cdp */
  browserMode: "host" | "cdp";
  /** CDP 端点（仅 cdp 模式） */
  cdpUrl?: string;
  /** 日志级别 */
  logLevel: string;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const apiKey = readEnv(env, "RUNNINGHUB_API_KEY") ?? "";
  const nativeModeRaw = readEnv(env, "RUNNINGHUB_NATIVE_MODE") ?? "standard";
  const browserModeRaw = readEnv(env, "RH_BROWSER_MODE") ?? "host";
  if (nativeModeRaw !== "standard" && nativeModeRaw !== "plus") {
    throw new Error(
      `RUNNINGHUB_NATIVE_MODE must be "standard" or "plus", got "${nativeModeRaw}"`,
    );
  }
  if (browserModeRaw !== "host" && browserModeRaw !== "cdp") {
    throw new Error(`RH_BROWSER_MODE must be "host" or "cdp", got "${browserModeRaw}"`);
  }
  return {
    apiKey,
    baseUrl: (readEnv(env, "RUNNINGHUB_BASE_URL") ?? "https://www.runninghub.ai").replace(
      /\/+$/,
      "",
    ),
    defaultWorkflowId: readEnv(env, "RUNNINGHUB_WORKFLOW_ID"),
    nativeMode: nativeModeRaw,
    browserMode: browserModeRaw,
    cdpUrl: readEnv(env, "RH_CDP_URL"),
    logLevel: readEnv(env, "RH_LOG_LEVEL") ?? "info",
  };
}

/**
 * 校验配置完备性（不抛错，返回结构化结果，供 doctor / CLI 使用）。
 */
export function checkConfig(config: BridgeConfig): {
  ok: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (config.apiKey === "") missing.push("RUNNINGHUB_API_KEY");
  return { ok: missing.length === 0, missing };
}

/** Native ComfyUI proxy base url；key 在 path 中，日志必须 redact（见 redaction.ts） */
export function nativeProxyBaseUrl(config: BridgeConfig): string {
  const prefix = config.nativeMode === "plus" ? "proxy-plus" : "proxy";
  return `${config.baseUrl}/${prefix}/${config.apiKey}`;
}

/** 安全打印配置（不含 key） */
export function describeConfig(config: BridgeConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    defaultWorkflowId: config.defaultWorkflowId ?? null,
    nativeMode: config.nativeMode,
    browserMode: config.browserMode,
    nativeProxyBase: redactString(nativeProxyBaseUrl(config), {
      secrets: [config.apiKey],
    }),
  };
}
