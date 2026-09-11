import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { createBridgeContext } from "../../src/services/context.js";
import { TOOL_REGISTRY } from "../../src/tools/registry.js";
import { parseApiFormat } from "../../src/graph/parse.js";
import type { FetchLike } from "../../src/clients/runninghub/client.js";
import { graphToWire } from "./helpers.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

// 测试用假 key（仅让 doctor 报 configured=true；非真实凭据）
const MCP_TEST_KEY = "test-key-for-mcp";

/** mock fetch：getJsonApiFormat 返回远端 seed=1（P0.1-03 基线用），create 被拦截保护挡在前面 */
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

let client: Client;
let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const env = { ...process.env } as Record<string, string | undefined>;
  env.RUNNINGHUB_API_KEY = MCP_TEST_KEY;
  env.RH_LOG_LEVEL = "silent";
  const ctx = createBridgeContext(env, { fetchImpl: remoteFetchMock });
  const server = buildMcpServer(ctx);
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  cleanup = async () => {
    await client.close();
    await server.close();
  };
});

afterAll(async () => {
  await cleanup?.();
});

function parseToolResult<T>(result: { content: Array<{ type: string; text: string }> }): T {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text) as T;
}

describe("MCP server（M6）", () => {
  it("listTools 暴露全部注册工具", async () => {
    const res = await client.listTools();
    expect(res.tools.map((t) => t.name).sort()).toEqual(TOOL_REGISTRY.map((t) => t.name).sort());
    // 可决策描述（04 §19）：不是一句空泛 "Manipulate RunningHub"
    const fetch = res.tools.find((t) => t.name === "rh_workflow_fetch");
    expect(fetch?.description.length ?? 0).toBeGreaterThan(40);
  });

  it("rh_workflow_patch：graph 输入 → 结构化 patch 输出（与 CLI 同一 service 层）", async () => {
    const graph = parseApiFormat(
      JSON.parse(readFileSync(path.join(FIXTURES, "basic-sdxl.json"), "utf-8")),
    );
    const res = await client.callTool({
      name: "rh_workflow_patch",
      arguments: {
        graph: graphToWire(graph),
        operations: [
          { type: "set_input", nodeId: "6", field: "text", value: "studio product photography" },
          { type: "set_input", nodeId: "3", field: "seed", value: 42 },
        ],
      },
    });
    if (res.isError) throw new Error("unexpected error");
    const parsed = parseToolResult<{
      recommendedExecutionMode: string;
      nodeInfoList: Array<{ nodeId: string; fieldName: string; fieldValue: unknown }>;
      diff: { topologyChanged: boolean };
    }>(res as { content: Array<{ type: string; text: string }> });
    expect(parsed.recommendedExecutionMode).toBe("nodeInfoList");
    expect(parsed.diff.topologyChanged).toBe(false);
    expect(parsed.nodeInfoList).toEqual([
      { nodeId: "3", fieldName: "seed", fieldValue: 42 },
      { nodeId: "6", fieldName: "text", fieldValue: "studio product photography" },
    ]);
  });

  it("rh_doctor（probeNative=false）→ 结构化体检结果（P0.1-07：configured 而非 authenticated）", async () => {
    const res = await client.callTool({
      name: "rh_doctor",
      arguments: { probeNative: false },
    });
    if (res.isError) throw new Error("unexpected error");
    const parsed = parseToolResult<{
      ok: boolean;
      runningHub: { configured: boolean; authenticationChecked: boolean };
    }>(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.runningHub.configured).toBe(true);
    expect(parsed.runningHub.authenticationChecked).toBe(false);
  });

  it("输入 schema 不合法 → isError 且说明校验原因（SDK 在 handler 前校验 shape）", async () => {
    const res = await client.callTool({
      name: "rh_workflow_fetch",
      arguments: { workflowId: "" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toMatch(/validation|invalid/i);
  });

  it("前端-only 字段 → 返回 browser fallback 请求（AT-401 MCP 路径，baseline 来自远端 fetch）", async () => {
    const graph = parseApiFormat(
      JSON.parse(readFileSync(path.join(FIXTURES, "basic-sdxl.json"), "utf-8")),
    );
    const res = await client.callTool({
      name: "rh_workflow_patch",
      arguments: {
        workflowId: "wf-mcp-test",
        graph: graphToWire(graph),
        operations: [
          { type: "set_input", nodeId: "3", field: "control_after_generate", value: "fixed" },
        ],
      },
    });
    if (res.isError) throw new Error("unexpected error");
    const parsed = parseToolResult<{
      requiresBrowser: boolean;
      reason: string;
      goal: string;
      strategy: string[];
      domainAllowlist: string[];
      preconditions: string[];
    }>(res);
    expect(parsed.requiresBrowser).toBe(true);
    expect(parsed.reason).toBe("FRONTEND_ONLY_FIELD");
    // AT-403：结构化语义 goal，不是像素坐标
    expect(parsed.goal).toContain("control_after_generate");
    expect(parsed.goal).not.toMatch(/x=\d+\s+y=\d+/);
    expect(parsed.strategy).toEqual(["DOM", "CDP", "vision"]);
    expect(parsed.domainAllowlist).toContain("runninghub.ai");
    expect(parsed.preconditions.join(" ")).toMatch(/snapshot/i);
    // P0.1-03：baseline 来自远端 fetch（seed=1），不是本地传入的 graph
    const snapshotPath = parsed.preconditions[0]?.match(/at (\S+)/)?.[1];
    expect(snapshotPath).toBeDefined();
    expect(snapshotPath).toMatch(/\.baseline\./);
    const content = JSON.parse(readFileSync(snapshotPath as string, "utf-8"));
    expect(content["3"].inputs.seed).toBe(1);
  });

  it("P0.1-04：MCP 直接 overrides 连接值被拦截（UNSUPPORTED）", async () => {
    const res = await client.callTool({
      name: "rh_workflow_run",
      arguments: {
        workflowId: "wf-x",
        overrides: [{ nodeId: "3", fieldName: "model", fieldValue: ["42", 0] }],
      },
    });
    expect(res.isError).toBe(true);
    const parsed = parseToolResult<{ error: { code: string; message: string } }>(res);
    expect(parsed.error.code).toBe("UNSUPPORTED");
    expect(parsed.error.message).toMatch(/full workflow JSON/);
  });

  it("P0.1-04：MCP 直接 overrides 前端-only 字段被拦截（REQUIRES_BROWSER）", async () => {
    const res = await client.callTool({
      name: "rh_workflow_run",
      arguments: {
        workflowId: "wf-x",
        overrides: [{ nodeId: "3", fieldName: "control_after_generate", fieldValue: "fixed" }],
      },
    });
    expect(res.isError).toBe(true);
    const parsed = parseToolResult<{ error: { code: string } }>(res);
    expect(parsed.error.code).toBe("REQUIRES_BROWSER");
  });
});
