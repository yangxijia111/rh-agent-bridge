/**
 * CLI 输出（04 §16/§17）：
 *  - --json（Agent 模式）：stdout 只输出 JSON；日志走 stderr
 *  - 默认人类可读：同样输出缩进 JSON（结果本身即结构化数据），简要提示走 stderr
 *
 * 输出目标可注入（测试进程内运行 CLI 用），默认 process.stdout / process.stderr。
 */
import { toRhError } from "../errors.js";

export interface OutputOptions {
  json: boolean;
}

export interface OutputSinks {
  out: (text: string) => void;
  err: (text: string) => void;
  setExitCode: (code: number) => void;
}

export const defaultSinks: OutputSinks = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export function printResult(value: unknown, options: OutputOptions, sinks: OutputSinks): void {
  sinks.out(JSON.stringify(value, null, 2) + "\n");
}

/** 错误出口：结构化 RhError JSON（--json 时），非零退出码。不抛出，由调用方 return。 */
export function printError(err: unknown, options: OutputOptions, sinks: OutputSinks): void {
  const rhErr = toRhError(err);
  if (options.json) {
    sinks.out(JSON.stringify({ error: rhErr.toJSON() }) + "\n");
  } else {
    sinks.err(`[${rhErr.code}] ${rhErr.message}\n`);
    if (rhErr.details && Object.keys(rhErr.details).length > 0) {
      sinks.err(JSON.stringify(rhErr.details, null, 2) + "\n");
    }
  }
  sinks.setExitCode(1);
}

/** 标记 CLI 已处理错误（main 里静默捕获以保持栈干净） */
export class CliHandledError extends Error {
  constructor() {
    super("cli handled");
    this.name = "CliHandledError";
  }
}
