/**
 * CLI 入口（04 §16、05 M5）。
 *
 * 命令与 tools/registry.ts 共用同一套 service 逻辑（不重复实现业务）。
 * --json 为 Agent 模式：stdout 只输出 JSON，日志全部走 stderr。
 *
 * buildProgram() 可注入输出流，测试进程内驱动 CLI（不依赖子进程）。
 */
import { Command, Option } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { parseApiFormat } from "../graph/parse.js";
import { serializeApiFormat } from "../graph/serialize.js";
import { chooseExecutionMode, graphChangesToNodeInfoList } from "../graph/execution.js";
import { rhError } from "../errors.js";
import { createBridgeContext } from "../services/context.js";
import { doctorTool } from "../tools/doctor.js";
import {
  workflowDiffTool,
  workflowFetchTool,
  workflowInspectTool,
  workflowPatchTool,
  workflowRunTool,
  workflowValidateTool,
} from "../tools/workflow-tools.js";
import { taskOutputsTool, taskWaitTool } from "../tools/task-tools.js";
import { resourceUploadTool } from "../tools/resource-tools.js";
import { nodesProbeTool, nodeSearchTool } from "../tools/nodes-tools.js";
import { browserFallbackRequestTool } from "../tools/browser-tools.js";
import { CliHandledError, defaultSinks, printError, printResult, type OutputSinks } from "./output.js";

/** JSON 值（CLI 字符串参数智能转换的目标类型） */
type JsonValue = string | number | boolean | null | unknown[] | Record<string, unknown>;

/** CLI --value 字符串智能转 JSON 值（seed=42 必须是数字而非字符串） */
function coerceValue(raw: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (parsed ?? null) as JsonValue;
  } catch {
    return raw;
  }
}

interface OverridePair {
  nodeId: string;
  fieldName: string;
  fieldValue: JsonValue;
}

/** 解析 nodeId.field=value（纯字符串切分，无模式执行） */
function parseOverridePair(value: string): OverridePair {
  const eq = value.indexOf("=");
  if (eq <= 0) {
    throw rhError("CONFIG", `--set expects nodeId.field=value, got "${value}"`);
  }
  const dotted = value.slice(0, eq);
  const dot = dotted.indexOf(".");
  if (dot <= 0 || dot === dotted.length - 1) {
    throw rhError("CONFIG", `--set expects nodeId.field=value, got "${value}"`);
  }
  return {
    nodeId: dotted.slice(0, dot),
    fieldName: dotted.slice(dot + 1),
    fieldValue: coerceValue(value.slice(eq + 1)),
  };
}

function parseNodeInfoJson(arg: string): OverridePair[] {
  const parsed = JSON.parse(arg) as unknown;
  if (!Array.isArray(parsed)) {
    throw rhError("INVALID_WORKFLOW", "nodeInfoList must be a JSON array");
  }
  return parsed as OverridePair[];
}

export function buildProgram(
  options: {
    sinks?: OutputSinks;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: import("../clients/runninghub/client.js").FetchLike;
  } = {},
) {
  const sinks = options.sinks ?? defaultSinks;
  const program = new Command();
  program
    .name("rh")
    .description(
      "RunningHub / ComfyUI workflow bridge for coding agents (API-first, browser-fallback)",
    )
    .version("0.1.1")
    .option("--json", "Agent mode: print machine-readable JSON to stdout only")
    .exitOverride((err) => {
      // --version / --help 属于正常退出；其余（unknown command 等）交给 catch 输出
      if (
        err.code === "commander.version" ||
        err.code === "commander.help" ||
        err.code === "commander.helpDisplayed"
      ) {
        process.exit(0);
      }
      throw err;
    });

  /** 惰性 context：只有真正需要时才创建（本地纯图操作不必强制配置 key） */
  let ctxCache: ReturnType<typeof createBridgeContext> | undefined;
  function ctx() {
    ctxCache ??= createBridgeContext(options.env ?? process.env, {
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    return ctxCache;
  }

  const outOptions = () => ({ json: program.opts().json === true });

  function readGraphFile(file: string) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      throw rhError("CONFIG", `failed to read workflow file: ${file}`);
    }
    return parseApiFormat(JSON.parse(text));
  }

  function writeGraphFile(file: string, graph: Parameters<typeof serializeApiFormat>[0]) {
    writeFileSync(file, JSON.stringify(serializeApiFormat(graph), null, 2) + "\n", "utf-8");
  }

  async function runCli(fn: () => Promise<unknown>): Promise<void> {
    try {
      const result = await fn();
      printResult(result, outOptions(), sinks);
    } catch (err) {
      if (err instanceof CliHandledError) return;
      printError(err, outOptions(), sinks);
      return;
    }
  }

  /* ---------------- doctor ---------------- */

  program
    .command("doctor")
    .description("check configuration and probe native ComfyUI capabilities")
    .option("--no-probe-native", "skip native capability probe")
    .action(async (opts: { probeNative: boolean }) => {
      await runCli(() => doctorTool(ctx(), { probeNative: opts.probeNative }));
    });

  /* ---------------- workflow ---------------- */

  const workflow = program.command("workflow").description("workflow operations");

  workflow
    .command("fetch")
    .description("fetch workflow API Format from RunningHub")
    .argument("<workflowId>")
    .option("--out <file>", "save API Format JSON to file")
    .action(async (workflowId: string, opts: { out?: string }) => {
      await runCli(async () => {
        const result = await workflowFetchTool(ctx(), { workflowId, includeRaw: true });
        if (opts.out) {
          writeFileSync(opts.out, JSON.stringify(result.rawApiFormat, null, 2) + "\n", "utf-8");
        }
        const { rawApiFormat: _drop, ...rest } = result;
        void _drop;
        return { ...rest, ...(opts.out ? { savedTo: opts.out } : {}) };
      });
    });

  workflow
    .command("inspect")
    .description("inspect workflow nodes (from API Format file)")
    .argument("<file>")
    .option("--query <q>", "filter by classType/title substring")
    .action(async (file: string, opts: { query?: string }) => {
      await runCli(async () => {
        const graph = readGraphFile(file);
        return workflowInspectTool(ctx(), { graph, query: opts.query });
      });
    });

  workflow
    .command("set-input")
    .description("set a node input value on an API Format file (syntax sugar of patch)")
    .argument("<file>")
    .requiredOption("--node <nodeId>")
    .requiredOption("--field <name>")
    .requiredOption("--value <value>")
    .option("--workflow-id <id>", "needed for frontend-only fields (remote baseline snapshot)")
    .option("--out <file>", "write modified API Format to file")
    .action(
      async (file: string, opts: { node: string; field: string; value: string; workflowId?: string; out?: string }) => {
        await runCli(async () => {
          const graph = readGraphFile(file);
          const result = await workflowPatchTool(ctx(), {
            graph,
            ...(opts.workflowId !== undefined ? { workflowId: opts.workflowId } : {}),
            operations: [
              {
                type: "set_input",
                nodeId: opts.node,
                field: opts.field,
                value: coerceValue(opts.value),
              },
            ],
            useNodeSchema: false,
          });
        if ("requiresBrowser" in result) return result;
        if (opts.out) writeGraphFile(opts.out, result.graph);
        return {
          diff: result.diff,
          validation: result.validation,
          recommendedExecutionMode: result.recommendedExecutionMode,
          nodeInfoList: result.nodeInfoList,
          ...(opts.out ? { savedTo: opts.out } : {}),
        };
        });
      },
    );

  workflow
    .command("patch")
    .description("apply graph operations to an API Format file")
    .argument("<file>")
    .requiredOption(
      "--ops <json>",
      "JSON array of operations (set_input/add_node/remove_node/connect/disconnect)",
    )
    .option("--out <file>", "write modified API Format to file")
    .option("--use-node-schema", "validate against live object_info catalog", false)
    .action(async (file: string, opts: { ops: string; out?: string; useNodeSchema: boolean }) => {
      await runCli(async () => {
        const graph = readGraphFile(file);
        let opsRaw: unknown;
        try {
          opsRaw = JSON.parse(opts.ops);
        } catch {
          throw rhError("INVALID_WORKFLOW", "--ops is not valid JSON");
        }
        const result = await workflowPatchTool(ctx(), {
          graph,
          operations: opsRaw as Parameters<typeof workflowPatchTool>[1]["operations"],
          useNodeSchema: opts.useNodeSchema,
        });
        if ("requiresBrowser" in result) return result;
        if (opts.out) writeGraphFile(opts.out, result.graph);
        return {
          assignedNodeIds: result.assignedNodeIds,
          diff: result.diff,
          warnings: result.warnings,
          validation: result.validation,
          recommendedExecutionMode: result.recommendedExecutionMode,
          nodeInfoList: result.nodeInfoList,
          ...(opts.out ? { savedTo: opts.out } : {}),
        };
      });
    });

  workflow
    .command("validate")
    .description("statically validate an API Format file")
    .argument("<file>")
    .option("--no-node-schema", "skip Level 2 object_info validation")
    .option("--check-models", "also validate model names against /models", false)
    .action(async (file: string, opts: { nodeSchema: boolean; checkModels: boolean }) => {
      await runCli(async () => {
        const graph = readGraphFile(file);
        return workflowValidateTool(ctx(), {
          graph,
          useNodeSchema: opts.nodeSchema,
          checkModels: opts.checkModels,
        });
      });
    });

  workflow
    .command("diff")
    .description("diff two API Format files")
    .argument("<beforeFile>")
    .argument("<afterFile>")
    .action(async (beforeFile: string, afterFile: string) => {
      await runCli(() =>
        workflowDiffTool(ctx(), {
          before: readGraphFile(beforeFile),
          after: readGraphFile(afterFile),
        }),
      );
    });

  workflow
    .command("run")
    .description(
      "submit a task (auto: nodeInfoList for value-only changes, full workflow for topology changes)",
    )
    .requiredOption("--workflow-id <id>")
    .option(
      "--file <file>",
      "API Format file; execution mode derived by diffing against the remote original",
    )
    .option("--node-info <json>", "explicit nodeInfoList JSON string")
    .option(
      "--set <nodeId.field=value>",
      "direct override, repeatable",
      (value: string, previous: string[] = []) => {
        previous.push(value);
        return previous;
      },
      [],
    )
    .addOption(
      new Option("--instance-type <type>", "standard (24GB) or plus (48GB)").choices([
        "standard",
        "plus",
      ]),
    )
    .action(
      async (opts: {
        workflowId: string;
        file?: string;
        nodeInfo?: string;
        set: string[];
        instanceType?: "standard" | "plus";
      }) => {
        await runCli(async () => {
          const c = ctx();
          // 直接覆盖：--set / --node-info → nodeInfoList 模式
          if (opts.set.length > 0 || opts.nodeInfo !== undefined) {
            const overrides = opts.set.map(parseOverridePair);
            if (opts.nodeInfo !== undefined) {
              overrides.push(...parseNodeInfoJson(opts.nodeInfo));
            }
            return workflowRunTool(c, {
              workflowId: opts.workflowId,
              overrides,
              instanceType: opts.instanceType,
            });
          }
          if (opts.file === undefined) {
            throw rhError("CONFIG", "provide --file, --set or --node-info");
          }
          // 文件模式：fetch 远端原版 → diff → 自动选择执行模式
          const remote = await c.workflow.fetch(opts.workflowId);
          const local = readGraphFile(opts.file);
          const diff = c.workflow.diff(remote.graph, local);
          const mode = chooseExecutionMode(diff);
          if (mode === "nodeInfoList") {
            const overrides = graphChangesToNodeInfoList(diff);
            return workflowRunTool(c, {
              workflowId: opts.workflowId,
              ...(overrides.length > 0 ? { overrides } : {}),
              instanceType: opts.instanceType,
            });
          }
          return workflowRunTool(c, {
            workflowId: opts.workflowId,
            graph: local,
            instanceType: opts.instanceType,
          });
        });
      },
    );

  /* ---------------- task ---------------- */

  const task = program.command("task").description("task operations");

  task
    .command("outputs")
    .description("fetch outputs/state for a taskId")
    .argument("<taskId>")
    .action(async (taskId: string) => {
      await runCli(() => taskOutputsTool(ctx(), { taskId }));
    });

  task
    .command("wait")
    .description("poll a taskId until it finishes, then print outputs")
    .argument("<taskId>")
    .option("--timeout-ms <n>", "overall timeout", (v) => Number(v), 300000)
    .option("--poll-interval-ms <n>", "fixed poll interval (default adaptive backoff)", (v) =>
      Number(v),
    )
    .action(async (taskId: string, opts: { timeoutMs: number; pollIntervalMs?: number }) => {
      await runCli(() =>
        taskWaitTool(ctx(), {
          taskId,
          timeoutMs: opts.timeoutMs,
          ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
        }),
      );
    });

  /* ---------------- resource ---------------- */

  const resource = program.command("resource").description("resource operations");

  resource
    .command("upload")
    .description("upload an image/audio/video/zip file (<=30MB)")
    .argument("<filePath>")
    .option("--file-type <type>", "RunningHub fileType", "input")
    .action(async (filePath: string, opts: { fileType: string }) => {
      await runCli(() => resourceUploadTool(ctx(), { path: filePath, fileType: opts.fileType }));
    });

  /* ---------------- nodes ---------------- */

  const nodes = program.command("nodes").description("node catalog operations");

  nodes
    .command("probe")
    .description("probe native ComfyUI endpoints and build node catalog")
    .option("--refresh", "force reload (skip cache)", false)
    .action(async (opts: { refresh: boolean }) => {
      await runCli(() => nodesProbeTool(ctx(), { refresh: opts.refresh }));
    });

  nodes
    .command("search")
    .description("search live node catalog")
    .argument("<query>")
    .option("--limit <n>", "max matches", (v) => Number(v), 10)
    .action(async (query: string, opts: { limit: number }) => {
      await runCli(() => nodeSearchTool(ctx(), { query, limit: opts.limit }));
    });

  /* ---------------- browser ---------------- */

  const browser = program.command("browser").description("browser fallback");

  browser
    .command("fallback-request")
    .description("build a structured browser fallback request (host mode)")
    .requiredOption("--workflow-id <id>")
    .requiredOption("--goal <goal>")
    .action(async (opts: { workflowId: string; goal: string }) => {
      await runCli(() =>
        browserFallbackRequestTool(ctx(), { workflowId: opts.workflowId, goal: opts.goal }),
      );
    });

  return program;
}

/* 入口：直接运行时 parse argv；被 import（测试）时不执行 */
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
const isDirectRun =
  process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      if (err instanceof CliHandledError) return;
      process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    });
}
