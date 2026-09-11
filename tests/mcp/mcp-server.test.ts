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
import { graphToWire } from "./helpers.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

// 测试用假 key（仅让 doctor 报 authenticated=true；非真实凭据，不触发网络请求）
const MCP_TEST_KEY = "test-key-for-mcp";

let client: Client;
let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const env = { ...process.env } as Record<string, string | undefined>;
  env.RUNNINGHUB_API_KEY = MCP_TEST_KEY;
  env.RH_LOG_LEVEL = "silent";
  const ctx = createBridgeContext(env);
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

  it("rh_doctor（probeNative=false）→ 结构化体检结果", async () => {
    const res = await client.callTool({
      name: "rh_doctor",
      arguments: { probeNative: false },
    });
    if (res.isError) throw new Error("unexpected error");
    const parsed = parseToolResult<{ ok: boolean; runningHub: { authenticated: boolean } }>(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.runningHub.authenticated).toBe(true);
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

  it("前端-only 字段 → 返回 browser fallback 请求（AT-401 MCP 路径）", async () => {
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
  });
});
