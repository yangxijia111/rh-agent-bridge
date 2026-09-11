import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrowserFallbackService, FRONTEND_ONLY_FIELDS } from "../../src/services/browser-fallback.js";
import { SnapshotStore } from "../../src/services/snapshots.js";
import { HostBrowserAdapter } from "../../src/browser/host-adapter.js";
import { parseApiFormat } from "../../src/graph/parse.js";
import type { RunningHubClient } from "../../src/clients/runninghub/client.js";

function makeService(options?: { snapshotStore?: SnapshotStore }): {
  service: BrowserFallbackService;
  rhCalls: () => number;
} {
  let rhCalls = 0;
  // mock RunningHubClient：只实现 workflow.getJsonApiFormat 计数
  const rh = {
    workflow: {
      getJsonApiFormat: async (_id: string) => {
        rhCalls += 1;
        return JSON.parse(
          JSON.stringify({
            "3": { class_type: "KSampler", inputs: { seed: 1, model: ["4", 0] } },
            "4": { class_type: "CheckpointLoaderSimple", inputs: {} },
          }),
        );
      },
    },
  } as unknown as RunningHubClient;
  const service = new BrowserFallbackService(
    rh,
    options?.snapshotStore ?? new SnapshotStore(path.join(tmpdirSafe(), "snapshots")),
    new HostBrowserAdapter(),
  );
  return { service, rhCalls: () => rhCalls };
}

function tmpdirSafe(): string {
  return mkdtempSync(path.join(tmpdir(), "rh-fallback-"));
}

describe("BrowserFallbackService（M8 host 模式）", () => {
  it("isFrontendOnlyField：官方文档列出的前端-only 字段（AT-401）", () => {
    const { service } = makeService();
    expect(service.isFrontendOnlyField("control_after_generate")).toBe(true);
    expect(service.isFrontendOnlyField("group")).toBe(true);
    expect(service.isFrontendOnlyField("text")).toBe(false);
    expect(service.isFrontendOnlyField("seed")).toBe(false);
    expect(FRONTEND_ONLY_FIELDS.has("control_after_generate")).toBe(true);
  });

  it("request：先保存 snapshot 再生成请求（AT-402）", async () => {
    const dir = tmpdirSafe();
    const store = new SnapshotStore(path.join(dir, "snapshots"));
    const { service } = makeService({ snapshotStore: store });
    const request = await service.request({ workflowId: "wf-1", goal: "toggle a UI-only switch" });
    expect(request.requiresBrowser).toBe(true);
    // preconditions 引用实际保存的 snapshot 文件（路径可解析且存在）
    const snapshotPath = request.preconditions[0]!.match(/at (\S+)/)?.[1];
    expect(snapshotPath).toBeTruthy();
    expect(() => readFileSync(snapshotPath!, "utf-8")).not.toThrow();
  });

  it("request：传入 graph 时不触发任何远端 API 调用（AT-401：No fake API call）", async () => {
    const { service, rhCalls } = makeService();
    const graph = parseApiFormat({
      "3": { class_type: "KSampler", inputs: { seed: 1 } },
    });
    await service.request({ workflowId: "wf-local", goal: "ui tweak", graph });
    expect(rhCalls()).toBe(0);
  });

  it("request：无 graph 时 fetch 远端当前态做 snapshot", async () => {
    const { service, rhCalls } = makeService();
    await service.request({ workflowId: "wf-remote", goal: "ui tweak" });
    expect(rhCalls()).toBe(1);
  });

  it("AT-403：输出结构化语义 goal，不是像素坐标", async () => {
    const { service } = makeService();
    const request = await service.request({
      workflowId: "wf-1",
      goal: "Open KSampler node and set control_after_generate to fixed",
    });
    expect(request.goal).toBe("Open KSampler node and set control_after_generate to fixed");
    expect(request.goal).not.toMatch(/x=\d+\s+y=\d+/);
    expect(request.strategy).toEqual(["DOM", "CDP", "vision"]);
    expect(request.domainAllowlist).toEqual(["runninghub.ai", "www.runninghub.ai"]);
    expect(request.postconditions).toEqual(
      expect.arrayContaining([expect.stringMatching(/rh_workflow_fetch/)]),
    );
  });

  it("AT-402：snapshot 保存失败时 request 抛错（不得继续浏览器变更）", async () => {
    const failingStore = {
      saveWorkflowSnapshot: async () => {
        throw new Error("disk full");
      },
    } as unknown as SnapshotStore;
    const { service } = makeService({ snapshotStore: failingStore });
    await expect(
      service.request({ workflowId: "wf-1", goal: "anything" }),
    ).rejects.toThrowError(/disk full/);
  });

  it("HostBrowserAdapter：mode=host 且不包含任何浏览器执行逻辑", () => {
    const adapter = new HostBrowserAdapter();
    expect(adapter.mode).toBe("host");
    const request = adapter.buildFallback({
      workflowId: "wf",
      goal: "g",
      snapshot: { filePath: "/tmp/s.json", savedAt: "now" },
    });
    expect(request.mode).toBe("host");
    expect(Object.keys(request)).not.toContain("click");
    expect(Object.keys(request)).not.toContain("coordinates");
  });

  it("快照文件内容 = API Format JSON（可用于回滚）", async () => {
    const dir = tmpdirSafe();
    const store = new SnapshotStore(path.join(dir, "s2"));
    const { service } = makeService({ snapshotStore: store });
    const graph = parseApiFormat({
      "3": { class_type: "KSampler", inputs: { seed: 7 } },
    });
    const request = await service.request({ workflowId: "wf-77", goal: "g", graph });
    const match = request.preconditions[0]!.match(/at (\S+)/);
    expect(match).toBeTruthy();
    const content = JSON.parse(readFileSync(match![1]!, "utf-8"));
    expect(content["3"].class_type).toBe("KSampler");
    expect(content["3"].inputs.seed).toBe(7);
  });
});
