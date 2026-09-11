import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunningHubClient, type FetchLike } from "../../src/clients/runninghub/client.js";
import { RhApiError, RhAuthError, RhRateLimitError } from "../../src/errors.js";

const TEST_KEY = "test-key-000";
const BASE = "https://www.runninghub.ai";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl: FetchLike = async (url, init) => handler(url, init);
  return new RunningHubClient({ baseUrl: BASE, apiKey: TEST_KEY, fetchImpl });
}

describe("WorkflowApi.getJsonApiFormat（AT-101 / AT-102）", () => {
  it("data.prompt JSON 字符串被二次 parse", async () => {
    const client = makeClient(() =>
      json({
        code: 0,
        msg: "SUCCESS",
        data: { prompt: JSON.stringify({ "3": { class_type: "KSampler", inputs: {} } }) },
      }),
    );
    const raw = await client.workflow.getJsonApiFormat("wf-1");
    expect(raw["3"]).toEqual({ class_type: "KSampler", inputs: {} });
  });

  it("malformed prompt 返回 INVALID_WORKFLOW_FORMAT", async () => {
    const client = makeClient(() => json({ code: 0, msg: "SUCCESS", data: { prompt: "not-json" } }));
    await expect(client.workflow.getJsonApiFormat("wf-1")).rejects.toMatchObject({
      code: "INVALID_WORKFLOW",
    });
  });

  it("请求携带 apiKey body 与 Bearer 头（官方双发）", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    let seenBody = "";
    const client = makeClient(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      seenBody = String(init.body);
      return json({ code: 0, msg: "SUCCESS", data: { prompt: "{}" } });
    });
    await client.workflow.getJsonApiFormat("wf-42");
    expect(seenUrl).toBe(`${BASE}/api/openapi/getJsonApiFormat`);
    expect((seenInit!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(JSON.parse(seenBody)).toEqual({ apiKey: TEST_KEY, workflowId: "wf-42" });
  });
});

describe("TaskApi.createTask", () => {
  const okResponse = () =>
    json({
      code: 0,
      msg: "success",
      data: {
        taskId: "1910246754753896450",
        taskStatus: "QUEUED",
        clientId: "c1",
        netWssUrl: null,
        promptTips: JSON.stringify({
          result: true,
          error: null,
          outputs_to_execute: ["9"],
          node_errors: {},
        }),
      },
    });

  it("解析 taskId 与 promptTips（AT-103 正常路径）", async () => {
    const client = makeClient(() => okResponse());
    const result = await client.task.createTask({
      workflowId: "wf-1",
      nodeInfoList: [{ nodeId: "6", fieldName: "text", fieldValue: "1 girl" }],
    });
    expect(result.taskId).toBe("1910246754753896450");
    expect(result.taskStatus).toBe("QUEUED");
    expect(result.promptTips).toEqual({
      result: true,
      error: null,
      outputs_to_execute: ["9"],
      node_errors: {},
    });
  });

  it("promptTips result=false 时结构化暴露 node_errors（AT-103）", async () => {
    const client = makeClient(() =>
      json({
        code: 0,
        msg: "success",
        data: {
          taskId: "1",
          promptTips: JSON.stringify({
            result: false,
            error: null,
            outputs_to_execute: [],
            node_errors: { "3": { errors: [] } },
          }),
        },
      }),
    );
    const result = await client.task.createTask({ workflowId: "wf-1" });
    expect(result.promptTips?.result).toBe(false);
    expect(result.promptTips?.node_errors).toHaveProperty("3");
  });

  it("完整 workflow 模式：workflow 字段进入 body", async () => {
    let seenBody = "";
    const client = makeClient(async (_url, init) => {
      seenBody = String(init.body);
      return okResponse();
    });
    const workflowJson = JSON.stringify({ "3": { class_type: "KSampler", inputs: {} } });
    await client.task.createTask({ workflowId: "wf-1", workflow: workflowJson });
    expect(JSON.parse(seenBody).workflow).toBe(workflowJson);
  });

  it("create task 禁止自动重试：5xx 直接抛错且只调用一次（防重复收费）", async () => {
    let calls = 0;
    const client = makeClient(() => {
      calls += 1;
      return json({ code: 500, msg: "server error" }, 500);
    });
    await expect(client.task.createTask({ workflowId: "wf-1" })).rejects.toMatchObject({
      code: "NETWORK",
    });
    expect(calls).toBe(1);
  });
});

describe("TaskApi.getTaskOutputs", () => {
  it("code=0 → SUCCEEDED 且输出结构化", async () => {
    const client = makeClient(() =>
      json({
        code: 0,
        msg: "success",
        data: [
          {
            fileUrl: "https://cdn.example.com/out.png",
            fileType: "png",
            taskCostTime: "83",
            nodeId: "12",
            consumeCoins: "17",
          },
        ],
      }),
    );
    const result = await client.task.getTaskOutputs("t-1");
    expect(result.state).toBe("SUCCEEDED");
    expect(result.outputs).toEqual([
      { url: "https://cdn.example.com/out.png", type: "png", nodeId: "12", costTimeSeconds: 83 },
    ]);
  });

  it("code=804 → RUNNING（官方 APIKEY_TASK_IS_RUNNING）", async () => {
    const client = makeClient(() =>
      json({ code: 804, msg: "APIKEY_TASK_IS_RUNNING", data: { netWssUrl: "wss://x" } }),
    );
    const result = await client.task.getTaskOutputs("t-1");
    expect(result.state).toBe("RUNNING");
  });

  it("code=805 → FAILED 且解析 failedReason", async () => {
    const client = makeClient(() =>
      json({
        code: 805,
        msg: "APIKEY_TASK_STATUS_ERROR",
        data: {
          failedReason: {
            node_name: "KSampler",
            node_id: "3",
            exception_type: "ValueError",
            exception_message: "bad seed",
          },
        },
      }),
    );
    const result = await client.task.getTaskOutputs("t-1");
    expect(result.state).toBe("FAILED");
    expect(result.failedReason).toMatchObject({ node_id: "3", exception_type: "ValueError" });
  });

  it("code=801 任务不存在 → 抛 RhApiError", async () => {
    const client = makeClient(() => json({ code: 801, msg: "APIKEY_TASK_NOT_EXIST", data: null }));
    await expect(client.task.getTaskOutputs("t-1")).rejects.toBeInstanceOf(RhApiError);
  });
});

describe("错误映射与重试", () => {
  it("HTTP 401 → RhAuthError", async () => {
    const client = makeClient(() => json({ code: 401, msg: "unauthorized" }, 401));
    await expect(client.workflow.getJsonApiFormat("wf-1")).rejects.toBeInstanceOf(RhAuthError);
  });

  it("HTTP 429 → RhRateLimitError", async () => {
    const client = makeClient(() => json({ code: 429, msg: "rate" }, 429));
    await expect(client.workflow.getJsonApiFormat("wf-1")).rejects.toBeInstanceOf(RhRateLimitError);
  });

  it("幂等请求允许重试：两次 500 后成功", async () => {
    let calls = 0;
    const client = makeClient(() => {
      calls += 1;
      if (calls < 3) return json({ code: 500, msg: "boom" }, 500);
      return json({ code: 0, msg: "SUCCESS", data: { prompt: "{}" } });
    });
    const raw = await client.workflow.getJsonApiFormat("wf-1");
    expect(raw).toEqual({});
    expect(calls).toBe(3);
  });

  it("HTTP 400 不重试", async () => {
    let calls = 0;
    const client = makeClient(() => {
      calls += 1;
      return json({ code: 400, msg: "bad request" }, 400);
    });
    await expect(client.workflow.getJsonApiFormat("wf-1")).rejects.toMatchObject({ code: "NETWORK" });
    expect(calls).toBe(1);
  });
});

describe("UploadApi.uploadResource（AT-104）", () => {
  it("fileName 原样保留，绝不拼接为 URL", async () => {
    let seenForm: FormData | undefined;
    const client = makeClient(async (_url, init) => {
      seenForm = init.body as FormData;
      return json({ code: 0, msg: "success", data: { fileName: "api/2026/x.png", fileType: "input" } });
    });
    const result = await client.uploadApi.uploadResource(
      "tests/fixtures/files/tiny.png",
      "input",
    );
    expect(result.fileName).toBe("api/2026/x.png");
    expect(result.fileName).not.toMatch(/^https?:/);
    expect(seenForm?.get("apiKey")).toBe(TEST_KEY);
    expect(seenForm?.get("fileType")).toBe("input");
    expect(seenForm?.get("file")).toBeTruthy();
  });
});

describe("P0.1-06/P0.1-12：contract fixture 驱动的响应契约测试", () => {
  const CONTRACTS = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "contracts",
  );
  const loadContract = (name: string): unknown =>
    JSON.parse(readFileSync(path.join(CONTRACTS, name), "utf-8"));

  it("create-success fixture：taskId/promptTips 解析（string taskCostTime 不在此路径）", async () => {
    const client = makeClient(async () => new Response(JSON.stringify(loadContract("runninghub-create-success.json")), { status: 200 }));
    const result = await client.task.createTask({ workflowId: "wf" });
    expect(result.taskId).toBe("1910246754753896450");
    expect(result.taskStatus).toBe("QUEUED");
    expect(result.promptTips?.result).toBe(true);
    expect(result.promptTips?.outputs_to_execute).toEqual(["9"]);
  });

  it("outputs-success（string taskCostTime）→ costTimeSeconds=83", async () => {
    const client = makeClient(async () => new Response(JSON.stringify(loadContract("runninghub-outputs-success-string-time.json")), { status: 200 }));
    const result = await client.task.getTaskOutputs("t");
    expect(result.state).toBe("SUCCEEDED");
    expect(result.outputs[0]?.costTimeSeconds).toBe(83);
  });

  it("outputs-success（number taskCostTime）→ costTimeSeconds=83（P0.1-06 双形态）", async () => {
    const client = makeClient(async () => new Response(JSON.stringify(loadContract("runninghub-outputs-success-number-time.json")), { status: 200 }));
    const result = await client.task.getTaskOutputs("t");
    expect(result.state).toBe("SUCCEEDED");
    expect(result.outputs[0]?.costTimeSeconds).toBe(83);
  });

  it("taskCostTime 非法字符串 → undefined（不泄露 NaN）", async () => {
    const client = makeClient(() =>
      json({
        code: 0,
        msg: "success",
        data: [{ fileUrl: "https://x/y.png", fileType: "png", taskCostTime: "not-a-number" }],
      }),
    );
    const result = await client.task.getTaskOutputs("t");
    expect(result.outputs[0]?.costTimeSeconds).toBeUndefined();
  });

  it("outputs-running fixture（code 804）→ RUNNING", async () => {
    const client = makeClient(async () => new Response(JSON.stringify(loadContract("runninghub-outputs-running.json")), { status: 200 }));
    const result = await client.task.getTaskOutputs("t");
    expect(result.state).toBe("RUNNING");
  });

  it("outputs-failed fixture（code 805）→ FAILED + failedReason", async () => {
    const client = makeClient(async () => new Response(JSON.stringify(loadContract("runninghub-outputs-failed.json")), { status: 200 }));
    const result = await client.task.getTaskOutputs("t");
    expect(result.state).toBe("FAILED");
    expect(result.failedReason).toMatchObject({ node_id: "3", exception_type: "ValueError" });
  });
});
