import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowService } from "../../src/services/workflow.js";
import { TaskService } from "../../src/services/task.js";
import { SnapshotStore } from "../../src/services/snapshots.js";
import { NodeCatalogService } from "../../src/catalog/cache.js";
import { NativeComfyClient } from "../../src/clients/comfy/client.js";
import type { RunningHubClient } from "../../src/clients/runninghub/client.js";
import type { CreateTaskInput, TaskOutputsResult } from "../../src/clients/runninghub/task.js";
import { parseApiFormat } from "../../src/graph/parse.js";

/* ---------- 可编程 mock RunningHubClient ---------- */

/** 远端 API Format（P0.1-03 基线测试用：远端 seed=1） */
const REMOTE_API_FORMAT = {
  "3": { class_type: "KSampler", inputs: { seed: 1 } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
};

interface RhMockState {
  createCalls: CreateTaskInput[];
  outputsScript: TaskOutputsResult[];
  outputsCalls: number;
  fetchCalls: number;
}

function makeRhMock(state: RhMockState): RunningHubClient {
  return {
    workflow: {
      getJsonApiFormat: async () => {
        state.fetchCalls += 1;
        return JSON.parse(JSON.stringify(REMOTE_API_FORMAT));
      },
    },
    task: {
      createTask: async (input: CreateTaskInput) => {
        state.createCalls.push(input);
        const tips = input.workflow ? JSON.stringify({ result: true, outputs_to_execute: ["9"], node_errors: {} }) : undefined;
        return {
          taskId: "task-1",
          taskStatus: "QUEUED",
          clientId: "c",
          netWssUrl: null,
          ...(tips ? { promptTips: JSON.parse(tips) } : {}),
        };
      },
      getTaskOutputs: async () => {
        const result = state.outputsScript[Math.min(state.outputsCalls, state.outputsScript.length - 1)]!;
        state.outputsCalls += 1;
        return result;
      },
      getTaskStatus: async () => ({ taskStatus: "QUEUED", raw: {} }),
    },
    uploadApi: { uploadResource: async () => ({ fileName: "api/x.png" }) },
    lora: { getLoraUploadUrl: async () => ({ fileName: "l.safetensors", uploadUrl: "https://signed", md5Hex: "0" }) },
    authHeaders: () => ({}),
  } as unknown as RunningHubClient;
}

function makeWorkflowService(rh: RunningHubClient, snapshotBase?: string): WorkflowService {
  const comfy = new NativeComfyClient({ proxyBaseUrl: "https://x/proxy/k" });
  const catalog = new NodeCatalogService(comfy);
  return new WorkflowService(
    rh,
    catalog,
    new SnapshotStore(snapshotBase ?? path.join(mkdtempSync(path.join(tmpdir(), "rh-svc-")), "snapshots")),
  );
}

/* ---------- WorkflowService.run ---------- */

describe("WorkflowService.run", () => {
  it("参数模式：nodeInfoList 直传，不生成 workflow 字段、不保存 snapshot 路径日志", async () => {
    const state: RhMockState = { createCalls: [], outputsScript: [], outputsCalls: 0, fetchCalls: 0 };
    const service = makeWorkflowService(makeRhMock(state));
    const result = await service.run({
      workflowId: "wf-1",
      overrides: [
        { nodeId: "6", fieldName: "text", fieldValue: "product photo" },
        { nodeId: "3", fieldName: "seed", fieldValue: 42 },
      ],
    });
    expect(result.executionMode).toBe("nodeInfoList");
    expect(result.taskId).toBe("task-1");
    expect(result.validation.valid).toBe(true);
    expect(state.createCalls[0]?.workflow).toBeUndefined();
    expect(state.createCalls[0]?.nodeInfoList).toHaveLength(2);
    // 参数模式不 fetch 远端、不生成快照
    expect(state.fetchCalls).toBe(0);
    expect(result.snapshots).toBeUndefined();
  });

  it("full workflow 模式：graph serialize 后进 workflow 字段", async () => {
    const state: RhMockState = { createCalls: [], outputsScript: [], outputsCalls: 0, fetchCalls: 0 };
    const service = makeWorkflowService(makeRhMock(state));
    const graph = parseApiFormat({
      "3": { class_type: "KSampler", inputs: { seed: 1 } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
    });
    const result = await service.run({ workflowId: "wf-1", graph });
    expect(result.executionMode).toBe("fullWorkflow");
    const sent = state.createCalls[0]?.workflow;
    expect(typeof sent).toBe("string");
    expect(JSON.parse(sent!)["3"].class_type).toBe("KSampler");
  });

  it("P0.1-03：full workflow run 的 baseline 是远端 seed=1，candidate 是提交的 seed=999", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rh-svc-"));
    const state: RhMockState = { createCalls: [], outputsScript: [], outputsCalls: 0, fetchCalls: 0 };
    const rh = makeRhMock(state);
    const store = new SnapshotStore(path.join(dir, "snaps"));
    const comfy = new NativeComfyClient({ proxyBaseUrl: "https://x/proxy/k" });
    const service = new WorkflowService(rh, new NodeCatalogService(comfy), store);

    // 候选 graph：seed=999（与远端 seed=1 不同）
    const candidate = parseApiFormat({
      "3": { class_type: "KSampler", inputs: { seed: 999 } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
    });
    const result = await service.run({ workflowId: "wf-baseline", graph: candidate });

    // 提交前必须 fetch 远端（baseline 来源）
    expect(state.fetchCalls).toBe(1);
    expect(result.snapshots).toBeDefined();
    const baseline = JSON.parse(readFileSync(result.snapshots!.baseline.filePath, "utf-8"));
    expect(baseline["3"].inputs.seed).toBe(1);
    expect(baseline["3"].inputs.seed).not.toBe(999);
    const candidateSaved = JSON.parse(readFileSync(result.snapshots!.candidate!.filePath, "utf-8"));
    expect(candidateSaved["3"].inputs.seed).toBe(999);
  });

  it("P0.1-04：run overrides 携带连接值 → UNSUPPORTED（Service boundary）", async () => {
    const state: RhMockState = { createCalls: [], outputsScript: [], outputsCalls: 0, fetchCalls: 0 };
    const service = makeWorkflowService(makeRhMock(state));
    await expect(
      service.run({
        workflowId: "wf-1",
        overrides: [{ nodeId: "3", fieldName: "model", fieldValue: ["42", 0] }],
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringMatching(/full workflow JSON/),
    });
    // 任务未被创建（保护先于提交）
    expect(state.createCalls).toHaveLength(0);
  });

  it("P0.1-04：run overrides 前端-only 字段 → REQUIRES_BROWSER（Service boundary）", async () => {
    const state: RhMockState = { createCalls: [], outputsScript: [], outputsCalls: 0, fetchCalls: 0 };
    const service = makeWorkflowService(makeRhMock(state));
    await expect(
      service.run({
        workflowId: "wf-1",
        overrides: [{ nodeId: "3", fieldName: "control_after_generate", fieldValue: "fixed" }],
      }),
    ).rejects.toMatchObject({ code: "REQUIRES_BROWSER" });
    expect(state.createCalls).toHaveLength(0);
  });

  it("promptTips result=false → validation.valid=false 且带 nodeErrors（AT-103 service 路径）", async () => {
    const rh = {
      workflow: { getJsonApiFormat: async () => ({}) },
      task: {
        createTask: async () => ({
          taskId: "t",
          taskStatus: "QUEUED",
          promptTips: { result: false, error: null, outputs_to_execute: [], node_errors: { "3": { errors: [] } } },
        }),
        getTaskOutputs: async () => ({ state: "RUNNING", outputs: [] }),
        getTaskStatus: async () => ({}),
      },
      uploadApi: {},
      lora: {},
      authHeaders: () => ({}),
    } as unknown as RunningHubClient;
    const service = makeWorkflowService(rh);
    const result = await service.run({ workflowId: "wf-1" });
    expect(result.validation.valid).toBe(false);
    expect(result.validation.nodeErrors).toHaveProperty("3");
  });
});

/* ---------- TaskService.wait ---------- */

describe("TaskService.wait（FR-07 轮询）", () => {
  function makeTaskService(script: TaskOutputsResult[]): { service: TaskService; state: RhMockState } {
    const state: RhMockState = { createCalls: [], outputsScript: script, outputsCalls: 0, fetchCalls: 0 };
    return { service: new TaskService(makeRhMock(state)), state };
  }

  const noSleep = async () => undefined;
  const fakeClock = (() => {
    let t = 0;
    return () => (t += 1000);
  })();

  it("首次查询即成功 → 直接返回", async () => {
    const { service } = makeTaskService([
      { state: "SUCCEEDED", outputs: [{ url: "https://cdn/x.png", type: "png", nodeId: "9" }] },
    ]);
    const result = await service.wait("t", { sleep: noSleep, now: fakeClock });
    expect(result.state).toBe("SUCCEEDED");
    expect(result.outputs[0]?.url).toBe("https://cdn/x.png");
  });

  it("RUNNING → SUCCEEDED：按退避轮询直到成功", async () => {
    const { service, state } = makeTaskService([
      { state: "RUNNING", outputs: [] },
      { state: "RUNNING", outputs: [] },
      { state: "SUCCEEDED", outputs: [] },
    ]);
    const result = await service.wait("t", { sleep: noSleep, now: fakeClock });
    expect(result.state).toBe("SUCCEEDED");
    expect(state.outputsCalls).toBe(3);
  });

  it("FAILED → 抛 RhError(TASK_FAILED) 带 failedReason（05 任务轮询语义）", async () => {
    const { service } = makeTaskService([
      { state: "FAILED", outputs: [], msg: "APIKEY_TASK_STATUS_ERROR", failedReason: { node_id: "3" } },
    ]);
    await expect(service.wait("t", { sleep: noSleep, now: fakeClock })).rejects.toMatchObject({
      code: "TASK_FAILED",
      details: { failedReason: { node_id: "3" } },
    });
  });

  it("超时 → RhError(TASK_TIMEOUT)", async () => {
    const { service } = makeTaskService([{ state: "RUNNING", outputs: [] }]);
    await expect(
      service.wait("t", { timeoutMs: 5000, sleep: noSleep, now: fakeClock }),
    ).rejects.toMatchObject({ code: "TASK_TIMEOUT" });
  });

  it("P0.1-08：UNKNOWN 业务码连续超过 2 次 → TASK_FAILED(UNKNOWN_API_STATE)，不再无限轮询", async () => {
    // 永远返回未知业务码 888
    const { service, state } = makeTaskService([
      { state: "UNKNOWN", outputs: [], msg: "SOME_NEW_CODE", apiCode: 888 },
    ]);
    await expect(
      service.wait("t", { timeoutMs: 10 ** 9, sleep: noSleep, now: fakeClock }),
    ).rejects.toMatchObject({
      code: "TASK_FAILED",
      details: { reason: "UNKNOWN_API_STATE", apiCode: 888, msg: "SOME_NEW_CODE" },
    });
    // 第 1、2 次容忍，第 3 次升级 → 共调用 3 次
    expect(state.outputsCalls).toBe(3);
  });

  it("P0.1-08：UNKNOWN→RUNNING→UNKNOWN 计数重置，不误杀", async () => {
    const { service } = makeTaskService([
      { state: "UNKNOWN", outputs: [], apiCode: 888 }, // count=1
      { state: "RUNNING", outputs: [] },               // count 重置
      { state: "UNKNOWN", outputs: [], apiCode: 888 }, // count=1（重置后）
      { state: "SUCCEEDED", outputs: [] },
    ]);
    const result = await service.wait("t", { sleep: noSleep, now: fakeClock, timeoutMs: 10 ** 9 });
    expect(result.state).toBe("SUCCEEDED");
  });

  it("abort signal → RhError(ABORTED)", async () => {
    const { service } = makeTaskService([{ state: "RUNNING", outputs: [] }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.wait("t", { sleep: noSleep, now: fakeClock, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("退避序列：1s,1s,2s,2s,3s,5s 后固定 5s（FR-07）", async () => {
    const script: TaskOutputsResult[] = Array.from({ length: 8 }, (_, i) =>
      i < 7 ? ({ state: "RUNNING", outputs: [] } as TaskOutputsResult) : ({ state: "SUCCEEDED", outputs: [] } as TaskOutputsResult),
    );
    const { service, state } = makeTaskService(script);
    const delays: number[] = [];
    const result = await service.wait("t", {
      sleep: async (ms) => {
        delays.push(ms);
      },
      now: fakeClock,
      timeoutMs: 10 ** 9,
    });
    expect(result.state).toBe("SUCCEEDED");
    // 7 次 RUNNING → 7 个 delay；前 6 个来自退避表，第 7 个为固定 5s
    expect(delays).toEqual([1000, 1000, 2000, 2000, 3000, 5000, 5000]);
    expect(state.outputsCalls).toBe(8);
  });
});
