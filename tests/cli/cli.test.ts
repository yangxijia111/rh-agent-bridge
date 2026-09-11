import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli/main.js";
import type { OutputSinks } from "../../src/cli/output.js";
import type { FetchLike } from "../../src/clients/runninghub/client.js";

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(PROJECT_ROOT, "tests", "fixtures");

interface Captured {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** mock fetch：getJsonApiFormat 返回远端 API Format（seed=1，P0.1-03 基线用） */
const remoteFetchMock: FetchLike = async (url) => {
  if (url.includes("/api/openapi/getJsonApiFormat")) {
    const remote = {
      "3": { class_type: "KSampler", inputs: { seed: 1 } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
    };
    return new Response(
      JSON.stringify({ code: 0, msg: "SUCCESS", data: { prompt: JSON.stringify(remote) } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ code: 404, msg: "not found" }), { status: 404 });
};

/** 进程内驱动 CLI：注入捕获流，环境无 API key（本地纯图命令不应需要） */
async function runCli(args: string[], options: { fetchImpl?: FetchLike } = {}): Promise<Captured> {
  const captured: Captured = { stdout: "", stderr: "", exitCode: 0 };
  const sinks: OutputSinks = {
    out: (text) => {
      captured.stdout += text;
    },
    err: (text) => {
      captured.stderr += text;
    },
    setExitCode: (code) => {
      captured.exitCode = code;
    },
  };
  const program = buildProgram({
    sinks,
    env: { ...process.env, RUNNINGHUB_API_KEY: "", RH_LOG_LEVEL: "silent" },
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  await program.parseAsync(args, { from: "user" });
  return captured;
}

async function runCliJson<T>(args: string[], options: { fetchImpl?: FetchLike } = {}): Promise<T> {
  const captured = await runCli(["--json", ...args], options);
  expect(captured.exitCode).toBe(0);
  return JSON.parse(captured.stdout) as T;
}

describe("CLI 本地图操作（M5）", () => {
  it("rh workflow inspect --query KSampler（04 §16 示例）", async () => {
    const result = await runCliJson<{ nodes: Array<{ id: string; classType: string }> }>([
      "workflow",
      "inspect",
      path.join(FIXTURES, "basic-sdxl.json"),
      "--query",
      "KSampler",
    ]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ id: "3", classType: "KSampler" });
    // 输出包含连接与常量分离
    expect(result.nodes[0]).toHaveProperty("connections");
    expect(result.nodes[0]).toHaveProperty("inputs");
  });

  it("rh workflow set-input：写出修改后的 API Format 文件（04 §16 示例）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rh-cli-"));
    const outFile = path.join(dir, "modified.json");
    const result = await runCliJson<{
      recommendedExecutionMode: string;
      savedTo: string;
      nodeInfoList: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>;
    }>([
      "workflow",
      "set-input",
      path.join(FIXTURES, "basic-sdxl.json"),
      "--node",
      "6",
      "--field",
      "text",
      "--value",
      "product photo",
      "--out",
      outFile,
    ]);
    expect(result.recommendedExecutionMode).toBe("nodeInfoList");
    expect(result.nodeInfoList).toEqual([
      { nodeId: "6", fieldName: "text", fieldValue: "product photo" },
    ]);
    const saved = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(saved["6"].inputs.text).toBe("product photo");
    // 其余节点未动
    expect(saved["3"].class_type).toBe("KSampler");
  });

  it("set-input 数字值被正确转成 number（seed）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rh-cli-"));
    const outFile = path.join(dir, "seed.json");
    await runCli([
      "workflow",
      "set-input",
      path.join(FIXTURES, "basic-sdxl.json"),
      "--node",
      "3",
      "--field",
      "seed",
      "--value",
      "42",
      "--out",
      outFile,
    ]);
    const saved = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(saved["3"].inputs.seed).toBe(42);
    expect(typeof saved["3"].inputs.seed).toBe("number");
  });

  it("rh workflow patch --ops：拓扑操作输出 fullWorkflow 模式", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rh-cli-"));
    const outFile = path.join(dir, "patched.json");
    const result = await runCliJson<{
      recommendedExecutionMode: string;
      assignedNodeIds: Record<string, string>;
      diff: { nodesAdded: string[]; topologyChanged: boolean };
    }>([
      "workflow",
      "patch",
      path.join(FIXTURES, "basic-sdxl.json"),
      "--ops",
      JSON.stringify([
        { type: "add_node", classType: "ImageUpscaleWithModel", title: "Upscale" },
        { type: "connect", fromNode: "8", outputIndex: 0, toNode: "10", input: "upscale_model" },
      ]),
      "--out",
      outFile,
    ]);
    expect(result.recommendedExecutionMode).toBe("fullWorkflow");
    expect(result.diff.topologyChanged).toBe(true);
    expect(result.diff.nodesAdded).toEqual(["10"]);
    expect(result.assignedNodeIds["#0"]).toBe("10");
    const saved = JSON.parse(readFileSync(outFile, "utf-8"));
    expect(saved["10"].class_type).toBe("ImageUpscaleWithModel");
    expect(saved["10"].inputs.upscale_model).toEqual(["8", 0]);
  });

  it("rh workflow validate（无 schema 路径）", async () => {
    const result = await runCliJson<{ valid: boolean; issues: Array<{ code: string }> }>([
      "workflow",
      "validate",
      path.join(FIXTURES, "broken-link.json"),
      "--no-node-schema",
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "MISSING_UPSTREAM_NODE")).toBe(true);
  });

  it("rh workflow diff 两个文件", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rh-cli-"));
    const modified = path.join(dir, "modified.json");
    await runCli([
      "workflow",
      "set-input",
      path.join(FIXTURES, "basic-sdxl.json"),
      "--node",
      "3",
      "--field",
      "steps",
      "--value",
      "30",
      "--out",
      modified,
    ]);
    const result = await runCliJson<{
      topologyChanged: boolean;
      inputsChanged: Array<{ nodeId: string; field: string; before: unknown; after: unknown }>;
    }>(["workflow", "diff", path.join(FIXTURES, "basic-sdxl.json"), modified]);
    expect(result.topologyChanged).toBe(false);
    expect(result.inputsChanged).toEqual([{ nodeId: "3", field: "steps", before: 20, after: 30 }]);
  });

  it("前端-only 字段 set-input（带 --workflow-id）返回 requiresBrowser 且不写文件（AT-401 CLI 路径）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rh-cli-"));
    const outFile = path.join(dir, "nope.json");
    writeFileSync(outFile, "", "utf-8");
    const result = await runCliJson<{ requiresBrowser: boolean; reason: string }>(
      [
        "workflow",
        "set-input",
        path.join(FIXTURES, "basic-sdxl.json"),
        "--node",
        "3",
        "--field",
        "control_after_generate",
        "--value",
        "fixed",
        "--workflow-id",
        "wf-at401",
        "--out",
        outFile,
      ],
      { fetchImpl: remoteFetchMock },
    );
    expect(result.requiresBrowser).toBe(true);
    expect(result.reason).toBe("FRONTEND_ONLY_FIELD");
    expect(readFileSync(outFile, "utf-8")).toBe("");
  });

  it("P0.1-03：前端-only fallback 的 baseline 快照是远端 seed=1，不是本地 candidate", async () => {
    // 本地文件 seed=156680208700286（basic-sdxl），远端 mock seed=1；
    // baseline 必须取远端 → 快照目录里 .baseline. 文件 seed=1
    const result = await runCliJson<{ preconditions: string[] }>(
      [
        "workflow",
        "set-input",
        path.join(FIXTURES, "basic-sdxl.json"),
        "--node",
        "3",
        "--field",
        "control_after_generate",
        "--value",
        "fixed",
        "--workflow-id",
        "wf-at401",
      ],
      { fetchImpl: remoteFetchMock },
    );
    const snapshotPath = result.preconditions[0]?.match(/at (\S+)/)?.[1];
    expect(snapshotPath).toBeDefined();
    expect(snapshotPath).toMatch(/\.baseline\./);
    const content = JSON.parse(readFileSync(snapshotPath, "utf-8"));
    expect(content["3"].inputs.seed).toBe(1);
  });

  it("P0.1-04：CLI run --set 连接值被拦截（UNSUPPORTED）", async () => {
    const captured = await runCli([
      "--json",
      "workflow",
      "run",
      "--workflow-id",
      "wf-x",
      "--set",
      '3.model=["42",0]',
    ]);
    expect(captured.exitCode).toBe(1);
    const parsed = JSON.parse(captured.stdout) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("UNSUPPORTED");
    expect(parsed.error.message).toMatch(/full workflow JSON/);
  });

  it("P0.1-04：CLI run --set 前端-only 字段被拦截（REQUIRES_BROWSER）", async () => {
    const captured = await runCli([
      "--json",
      "workflow",
      "run",
      "--workflow-id",
      "wf-x",
      "--set",
      "3.control_after_generate=fixed",
    ]);
    expect(captured.exitCode).toBe(1);
    const parsed = JSON.parse(captured.stdout) as { error: { code: string } };
    expect(parsed.error.code).toBe("REQUIRES_BROWSER");
  });

  it("doctor --no-probe-native：缺 key 时结构化报告（P0.1-07：configured 而非 authenticated）", async () => {
    const result = await runCliJson<{
      ok: boolean;
      runningHub: { configured: boolean; authenticationChecked: boolean; missing?: string[] };
    }>(["doctor", "--no-probe-native"]);
    expect(result.ok).toBe(false);
    expect(result.runningHub.configured).toBe(false);
    expect(result.runningHub.authenticationChecked).toBe(false);
    expect(result.runningHub.missing).toContain("RUNNINGHUB_API_KEY");
  });

  it("--json 模式 stdout 只含 JSON（Agent 模式契约）", async () => {
    const captured = await runCli(["--json", "workflow", "inspect", path.join(FIXTURES, "cycle.json")]);
    expect(() => JSON.parse(captured.stdout)).not.toThrow();
  });

  it("错误时 --json 输出结构化 error 且退出码 1", async () => {
    const captured = await runCli(["--json", "workflow", "inspect", path.join(FIXTURES, "not-exist.json")]);
    expect(captured.exitCode).toBe(1);
    const parsed = JSON.parse(captured.stdout) as { error: { code: string } };
    expect(parsed.error.code).toBe("CONFIG");
  });
});
