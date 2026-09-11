/**
 * 统一错误模型（02_ARCHITECTURE.md §12）。
 *
 * 永远不要把原始 fetch 错误直接暴露给调用方；
 * 所有对外错误都必须携带结构化 code 与 retryable 标记。
 */

export type RhErrorCode =
  | "AUTH"
  | "NETWORK"
  | "RATE_LIMIT"
  | "INVALID_WORKFLOW"
  | "INVALID_WORKFLOW_FORMAT"
  | "NODE_NOT_FOUND"
  | "MODEL_NOT_FOUND"
  | "NODE_IN_USE"
  | "UPLOAD_FAILED"
  | "TASK_FAILED"
  | "TASK_TIMEOUT"
  | "ABORTED"
  | "UNSUPPORTED"
  | "REQUIRES_BROWSER"
  | "CONFIG";

export interface RhErrorDetails {
  [key: string]: unknown;
}

export class RhError extends Error {
  readonly code: RhErrorCode;
  readonly retryable: boolean;
  details?: RhErrorDetails;

  constructor(
    code: RhErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: RhErrorDetails; cause?: unknown },
  ) {
    super(message);
    this.name = "RhError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /** 序列化为 Agent 友好的 JSON 结构 */
  toJSON(): {
    code: RhErrorCode;
    message: string;
    retryable: boolean;
    details?: RhErrorDetails;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/** HTTP 401 / 鉴权失败 */
export class RhAuthError extends RhError {
  constructor(message = "RunningHub authentication failed", details?: RhErrorDetails) {
    super("AUTH", message, { details });
    this.name = "RhAuthError";
  }
}

/** HTTP 429 */
export class RhRateLimitError extends RhError {
  constructor(message = "RunningHub rate limit hit", details?: RhErrorDetails) {
    super("RATE_LIMIT", message, { retryable: true, details });
    this.name = "RhRateLimitError";
  }
}

/** 网络层错误（超时、连接重置等）；非可重试 HTTP 状态（400/404 等）也归此类但 retryable=false */
export class RhNetworkError extends RhError {
  constructor(message: string, details?: RhErrorDetails, cause?: unknown, retryable = true) {
    super("NETWORK", message, { retryable, details, cause });
    this.name = "RhNetworkError";
  }
}

/** RunningHub 返回 code != 0 的业务错误 */
export class RhApiError extends RhError {
  readonly apiCode: number;
  constructor(apiCode: number, msg: string, details?: RhErrorDetails) {
    super("TASK_FAILED", `RunningHub API error ${apiCode}: ${msg}`, {
      details: { apiCode, msg, ...details },
    });
    this.name = "RhApiError";
    this.apiCode = apiCode;
  }
}

/** workflow JSON / graph 结构非法 */
export class RhInvalidWorkflowError extends RhError {
  constructor(message: string, details?: RhErrorDetails) {
    super("INVALID_WORKFLOW", message, { details });
    this.name = "RhInvalidWorkflowError";
  }
}

/** 浏览器兜底请求（不是异常路径，而是结构化转向信号） */
export class RhRequiresBrowserError extends RhError {
  constructor(message: string, details?: RhErrorDetails) {
    super("REQUIRES_BROWSER", message, { details });
    this.name = "RhRequiresBrowserError";
  }
}

/** 把任意未知错误归一为 RhError（用于 CLI/MCP 出口处） */
export function toRhError(err: unknown): RhError {
  if (err instanceof RhError) return err;
  if (err instanceof Error) {
    return new RhError("NETWORK", err.message, { retryable: false, cause: err });
  }
  return new RhError("NETWORK", String(err));
}

/** 快捷构造：第三参直接是 details（内部大量调用点的惯用形态） */
export function rhError(code: RhErrorCode, message: string, details?: RhErrorDetails): RhError {
  return new RhError(code, message, { details });
}
