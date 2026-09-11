/**
 * Native ComfyUI client（02_ARCHITECTURE.md §5、03 §12-§13）。
 *
 * Base URL：
 *   standard: https://www.runninghub.ai/proxy/<API_KEY>
 *   plus:     https://www.runninghub.ai/proxy-plus/<API_KEY>
 *
 * API key 在 URL path 中——所有日志输出必须先经 redaction
 * （client 本身只记录 path，不记录完整 URL）。
 *
 * 每个端点均需运行时 feature-detect：不假设标准路由必然可用。
 */
import type { Logger } from "../../config/logger.js";
import { RhNetworkError } from "../../errors.js";
import type { FetchLike } from "../runninghub/client.js";
import { featuresSchema, modelsSchema, objectInfoSchema, type ModelsRaw, type ObjectInfoRaw } from "./schemas.js";

export interface NativeComfyClientOptions {
  /** 已含 /proxy/<key> 的 base url；禁止直接写日志 */
  proxyBaseUrl: string;
  logger?: Logger;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export type NativeEndpointResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; error: string };

export class NativeComfyClient {
  private readonly proxyBaseUrl: string;
  private readonly logger?: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: NativeComfyClientOptions) {
    this.proxyBaseUrl = options.proxyBaseUrl.replace(/\/+$/, "");
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** 日志只出现 path，绝不出现含 key 的完整 URL */
  private logPath(path: string): string {
    return `native${path}`;
  }

  async getObjectInfo(): Promise<NativeEndpointResult<ObjectInfoRaw>> {
    return this.getJson("/object_info", objectInfoSchema);
  }

  async getObjectInfoByClass(classType: string): Promise<NativeEndpointResult<ObjectInfoRaw>> {
    return this.getJson(`/object_info/${encodeURIComponent(classType)}`, objectInfoSchema);
  }

  async getModels(): Promise<NativeEndpointResult<ModelsRaw>> {
    return this.getJson("/models", modelsSchema);
  }

  async getFeatures(): Promise<NativeEndpointResult<Record<string, unknown>>> {
    return this.getJson("/features", featuresSchema);
  }

  private async getJson<T>(
    path: string,
    schema: { parse(value: unknown): T },
  ): Promise<NativeEndpointResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.proxyBaseUrl}${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      this.logger?.debug("native comfy response", { path: this.logPath(path), status: response.status });
      if (!response.ok) {
        return { ok: false, status: response.status, error: `HTTP ${response.status}` };
      }
      const text = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, status: response.status, error: "non-JSON body" };
      }
      const parsed = schema.parse(json);
      return { ok: true, data: parsed, status: response.status };
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `timeout after ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      // 网络/超时错误：返回失败结果而不是抛出——探测场景必须能降级
      return { ok: false, status: 0, error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}

export { RhNetworkError };
