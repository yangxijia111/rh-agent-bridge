/**
 * 日志（01_PRD.md Observability）。
 *
 * - CLI 模式：日志写 stderr，stdout 只留给 JSON 输出（04 §17）
 * - 所有输出经 redaction 处理
 * - 结构化字段：requestId / tool / workflowId / taskId / durationMs / status / errorCode
 */
import pino from "pino";
import { redactString, redactValue, type RedactionConfig } from "./redaction.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(options: {
  level?: string;
  redaction: RedactionConfig;
  sink?: (line: string) => void;
}): Logger {
  const level = normalizeLevel(options.level ?? "info");
  // silent 时返回 no-op，避免 pino 级别过滤开销
  if (level === "silent") {
    const noop = (): void => undefined;
    return {
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      child: () => createLogger({ level: "silent", redaction: options.redaction, sink: options.sink }),
    };
  }
  const write = (line: string) => (options.sink ?? process.stderr.write.bind(process.stderr))(line + "\n");
  const instance = pino({ level, base: undefined }, { write });
  return {
    trace: (msg, data) => instance.trace(safeData(data, options.redaction), redactString(msg, options.redaction)),
    debug: (msg, data) => instance.debug(safeData(data, options.redaction), redactString(msg, options.redaction)),
    info: (msg, data) => instance.info(safeData(data, options.redaction), redactString(msg, options.redaction)),
    warn: (msg, data) => instance.warn(safeData(data, options.redaction), redactString(msg, options.redaction)),
    error: (msg, data) => instance.error(safeData(data, options.redaction), redactString(msg, options.redaction)),
    child: (bindings) => createChild(instance, bindings, options.redaction),
  };
}

function createChild(instance: pino.Logger, bindings: Record<string, unknown>, redaction: RedactionConfig): Logger {
  const child = instance.child(redactValue(bindings, redaction) as Record<string, unknown>);
  return {
    trace: (msg, data) => child.trace(safeData(data, redaction), redactString(msg, redaction)),
    debug: (msg, data) => child.debug(safeData(data, redaction), redactString(msg, redaction)),
    info: (msg, data) => child.info(safeData(data, redaction), redactString(msg, redaction)),
    warn: (msg, data) => child.warn(safeData(data, redaction), redactString(msg, redaction)),
    error: (msg, data) => child.error(safeData(data, redaction), redactString(msg, redaction)),
    child: (b) => createChild(child, b, redaction),
  };
}

function safeData(data: Record<string, unknown> | undefined, redaction: RedactionConfig): Record<string, unknown> {
  return data ? (redactValue(data, redaction) as Record<string, unknown>) : {};
}

function normalizeLevel(level: string): LogLevel {
  const allowed: LogLevel[] = ["trace", "debug", "info", "warn", "error", "silent"];
  return (allowed as string[]).includes(level) ? (level as LogLevel) : "info";
}
