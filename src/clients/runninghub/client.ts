/**
 * RunningHub OpenAPI client 核心（02_ARCHITECTURE.md §4）。
 *
 * Client 只管协议，不管业务：
 *  - 统一 request wrapper（timeout / retry / 脱敏日志 / 错误映射）
 *  - 认证：同时发送 Authorization: Bearer 头与 body.apiKey（官方示例两者都带，03 §1）
 *
 * 重试策略（05_IMPLEMENTATION_PLAN）：
 *  - 自动重试：408 / 429 / 500 / 502 / 503 / 504 / 网络层错误，最多 3 次
 *  - 不重试：400 / 401 / 403 / 404 / 业务 code 错误
 *  - create task 与 upload 默认禁止自动重试（重复收费 / 重复上传风险）
 */
import { randomUUID } from "node:crypto";
import type { Logger } from "../../config/logger.js";
import {
  RhApiError,
  RhAuthError,
  RhNetworkError,
  RhRateLimitError,
  RhError,
} from "../../errors.js";
import { WorkflowApi } from "./workflow.js";
import { TaskApi } from "./task.js";
import { UploadApi } from "./upload.js";
import { LoraApi } from "./lora.js";

export type FetchLike = (
  input: string,
  init: RequestInit & { signal?: AbortSignal },
) => Promise<Response>;

export interface RunningHubClientOptions {
  baseUrl: string;
  apiKey: string;
  logger?: Logger;
  fetchImpl?: FetchLike;
  defaultTimeoutMs?: number;
}

export interface RequestOptions {
  method: "GET" | "POST";
  /** API path，如 /task/openapi/create */
  path: string;
  body?: Record<string, unknown>;
  /** multipart 表单（upload 用） */
  formData?: FormData;
  timeoutMs?: number;
  /**
   * 是否允许自动重试。
   * create task / upload 必须传 false（不可幂等，重复执行产生费用）。
   */
  allowRetry?: boolean;
}

export interface RequestContext {
  /** 官方要求 body 同时携带 apiKey；各 API 模块从这里取 */
  readonly apiKey: string;
  request<T>(options: RequestOptions, parseData: (data: unknown) => T): Promise<T>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

export class RunningHubClient {
  readonly workflow: WorkflowApi;
  readonly task: TaskApi;
  readonly uploadApi: UploadApi;
  readonly lora: LoraApi;

  private readonly options: RunningHubClientOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: RunningHubClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    const ctx: RequestContext = {
      apiKey: options.apiKey,
      request: (req, parseData) => this.request(req, parseData),
    };
    this.workflow = new WorkflowApi(ctx);
    this.task = new TaskApi(ctx);
    this.uploadApi = new UploadApi(ctx, () => this.authHeaders());
    this.lora = new LoraApi(ctx);
  }

  /** Bearer 认证头（与 body.apiKey 并存，按官方示例双发） */
  authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.apiKey}` };
  }

  private async request<T>(options: RequestOptions, parseData: (data: unknown) => T): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    const allowRetry = options.allowRetry ?? false;
    const url = `${this.options.baseUrl}${options.path}`;

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const requestId = randomUUID();
      const startedAt = Date.now();
      try {
        const init: RequestInit & { signal?: AbortSignal } = {
          method: options.method,
          headers: {
            ...(options.formData ? {} : { "Content-Type": "application/json" }),
            ...this.authHeaders(),
          },
          signal: controller.signal,
        };
        if (options.formData) {
          init.body = options.formData;
        } else if (options.body !== undefined) {
          init.body = JSON.stringify(options.body);
        }
        const response = await this.fetchImpl(url, init);
        const text = await response.text();
        this.options.logger?.debug("runninghub api response", {
          requestId,
          path: options.path,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });

        if (!response.ok) {
          if (RETRYABLE_STATUS.has(response.status) && allowRetry && attempt < MAX_RETRIES) {
            attempt += 1;
            await sleep(backoffMs(attempt));
            continue;
          }
          throw httpError(response.status, text);
        }

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(text);
        } catch {
          throw new RhNetworkError(`RunningHub returned non-JSON body for ${options.path}`, {
            path: options.path,
            bodyPreview: preview(text),
          });
        }

        const envelope = parseEnvelope(parsedJson, options.path);
        if (envelope.code !== 0) {
          // 业务错误统一抛 RhApiError；task.ts 捕获后按 apiCode 区分 804/805 运行态
          throw new RhApiError(envelope.code, envelope.msg, {
            path: options.path,
            data: envelope.data,
          });
        }
        return parseData(envelope.data);
      } catch (err) {
        if (isRetryableNetworkError(err) && allowRetry && attempt < MAX_RETRIES) {
          attempt += 1;
          this.options.logger?.warn("runninghub api retryable error, retrying", {
            requestId,
            path: options.path,
            attempt,
            durationMs: Date.now() - startedAt,
          });
          await sleep(backoffMs(attempt));
          continue;
        }
        throw normalizeError(err, options.path);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/* ---------------- 内部工具 ---------------- */

function parseEnvelope(value: unknown, path: string): { code: number; msg: string; data?: unknown } {
  if (value === null || typeof value !== "object") {
    throw new RhNetworkError(`RunningHub response for ${path} is not an object`, { path });
  }
  const obj = value as Record<string, unknown>;
  const code = obj.code;
  const msg = typeof obj.msg === "string" ? obj.msg : "";
  if (typeof code !== "number") {
    throw new RhNetworkError(`RunningHub response for ${path} missing numeric code`, { path });
  }
  return { code, msg, data: obj.data };
}

function httpError(status: number, bodyText: string): RhError {
  if (status === 401) {
    return new RhAuthError("RunningHub returned 401 for this API key");
  }
  if (status === 429) return new RhRateLimitError("RunningHub returned 429 rate limit");
  const details = { status, bodyPreview: preview(bodyText) };
  if (RETRYABLE_STATUS.has(status)) {
    return new RhNetworkError(`RunningHub HTTP ${status}`, details);
  }
  // 400/403/404 等：不可重试
  return new RhNetworkError(`RunningHub HTTP ${status}`, details, undefined, false);
}

function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof RhError) return err.retryable && err.code === "NETWORK";
  if (err instanceof Error) {
    return (
      err.name === "AbortError" ||
      err.name === "TypeError" ||
      /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(err.message)
    );
  }
  return false;
}

function normalizeError(err: unknown, path: string): RhError {
  if (err instanceof RhError) {
    return err;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new RhNetworkError(`Request to ${path} timed out`, { path }, err);
  }
  return new RhNetworkError(
    `Request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
    { path },
    err,
  );
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 4000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preview(text: string): string {
  return text.length > 200 ? text.slice(0, 200) + "..." : text;
}
