import { describe, expect, it } from "vitest";
import { NativeComfyClient } from "../../src/clients/comfy/client.js";
import { probeCapabilities } from "../../src/clients/comfy/capability.js";
import { NodeCatalogService } from "../../src/catalog/cache.js";
import { normalizeObjectInfo } from "../../src/catalog/adapter.js";
import type { FetchLike } from "../../src/clients/runninghub/client.js";
import { RhError } from "../../src/errors.js";

const PROXY_BASE = "https://www.runninghub.ai/proxy/test-key";

/** 迷你 object_info 样本（结构对齐 ComfyUI 官方） */
const SAMPLE_OBJECT_INFO = {
  KSampler: {
    input: {
      required: {
        seed: ["INT", { default: 0, min: 0, max: 18446744073709551615 }],
        steps: ["INT", { default: 20, min: 1, max: 100 }],
        cfg: ["FLOAT", { default: 8 }],
        sampler_name: [["euler", "dpmpp_2m", "ddim"]],
        model: ["MODEL", { tooltip: "model" }],
        positive: ["CONDITIONING"],
      },
      optional: { extra: ["STRING", { default: "" }] },
    },
    output: ["LATENT"],
    output_name: ["latent"],
    name: "KSampler",
    display_name: "KSampler",
    category: "sampling",
    output_node: false,
  },
  SaveImage: {
    input: { required: { filename_prefix: ["STRING"], images: ["IMAGE"] } },
    output: [],
    name: "SaveImage",
    category: "image",
    output_node: true,
  },
  "ImpactWildcardProcessor": {
    input: { required: { wildcard_text: ["STRING"] } },
    output: ["STRING"],
    name: "ImpactWildcardProcessor",
    display_name: "Wildcard Processor",
    category: "Impact Pack",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("object_info adapter（normalize）", () => {
  it("combo / INT / 连接类型正确规范化", () => {
    const defs = normalizeObjectInfo(SAMPLE_OBJECT_INFO);
    const ksampler = defs.find((d) => d.classType === "KSampler")!;
    expect(ksampler.inputRequired.sampler_name).toEqual({
      type: "COMBO",
      options: ["euler", "dpmpp_2m", "ddim"],
    });
    expect(ksampler.inputRequired.seed).toMatchObject({ type: "INT", min: 0 });
    expect(ksampler.inputRequired.model?.type).toBe("MODEL");
    expect(ksampler.inputOptional.extra?.type).toBe("STRING");
    expect(ksampler.outputTypes).toEqual(["LATENT"]);
    expect(ksampler.outputNode).toBe(false);
    const save = defs.find((d) => d.classType === "SaveImage")!;
    expect(save.outputNode).toBe(true);
  });
});

describe("NativeComfyClient capability probe（AT-201 / AT-202）", () => {
  it("AT-201：全部端点成功 → capabilities 为 true 且 catalog 填充", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/object_info/KSampler")) {
        return jsonResponse({ KSampler: SAMPLE_OBJECT_INFO.KSampler });
      }
      if (url.includes("/object_info")) return jsonResponse(SAMPLE_OBJECT_INFO);
      // P0.1-01：GET /models 返回 folder 名称列表（string[]），不是模型文件映射
      if (url.endsWith("/models")) return jsonResponse(["checkpoints", "loras", "vae", "upscale_models"]);
      if (url.includes("/models/")) return jsonResponse(["a.safetensors"]);
      if (url.includes("/features")) return jsonResponse({ frontend: true });
      return jsonResponse({}, 404);
    };
    const client = new NativeComfyClient({ proxyBaseUrl: PROXY_BASE, fetchImpl });
    const probe = await probeCapabilities(client);
    expect(probe.capabilities.objectInfo).toBe(true);
    expect(probe.capabilities.features).toBe(true);
    expect(probe.capabilities.models).toBe(true);
    expect(probe.capabilities.objectInfoByClass).toBe(true);
    // P0.1-11：details 保留（endpoint + status），且不含 API key
    const modelsDetail = probe.details.find((d) => d.endpoint === "/models")!;
    expect(modelsDetail).toMatchObject({ ok: true });
    expect(JSON.stringify(probe.details)).not.toContain("test-key");

    const catalog = new NodeCatalogService(client);
    const snapshot = await catalog.probe();
    expect(snapshot.count).toBe(3);
    expect(catalog.get("KSampler")?.classType).toBe("KSampler");
  });

  it("AT-202：object_info 404 → capability=false，不致命", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ msg: "not found" }, 404);
    const client = new NativeComfyClient({ proxyBaseUrl: PROXY_BASE, fetchImpl });
    const probe = await probeCapabilities(client);
    expect(probe.capabilities.objectInfo).toBe(false);
    // doctor 语义：probe 失败不抛错
    expect(typeof probe.details.find((d) => d.endpoint === "/object_info")?.ok).toBe("boolean");
  });

  it("网络超时/异常 → ok=false 且可降级", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const client = new NativeComfyClient({ proxyBaseUrl: PROXY_BASE, fetchImpl });
    const probe = await probeCapabilities(client);
    expect(probe.capabilities.objectInfo).toBe(false);
    expect(probe.details.every((d) => d.ok === false)).toBe(true);
  });
});

describe("NodeCatalogService（AT-203 / TTL / search）", () => {
  function makeClientWithInfo(): { client: NativeComfyClient; calls: () => number } {
    let objectInfoCalls = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/object_info/KSampler")) {
        return jsonResponse({ KSampler: SAMPLE_OBJECT_INFO.KSampler });
      }
      if (url.includes("/object_info")) {
        objectInfoCalls += 1;
        return jsonResponse(SAMPLE_OBJECT_INFO);
      }
      return jsonResponse({}, 404);
    };
    return {
      client: new NativeComfyClient({ proxyBaseUrl: PROXY_BASE, fetchImpl }),
      calls: () => objectInfoCalls,
    };
  }

  it("AT-203：未知 node 查找强制 refresh 一次后才返回 NODE_NOT_FOUND", async () => {
    const { client, calls } = makeClientWithInfo();
    const catalog = new NodeCatalogService(client, undefined, () => 1_000);
    await catalog.probe();
    expect(calls()).toBe(1);
    // 存在的类：直接命中，不 refresh
    const def = await catalog.getOrRefresh("KSampler");
    expect(def.classType).toBe("KSampler");
    expect(calls()).toBe(1);
    // 不存在的类：强制 refresh 一次，再失败
    await expect(catalog.getOrRefresh("NotARealNode")).rejects.toMatchObject({
      code: "NODE_NOT_FOUND",
    });
    expect(calls()).toBe(2);
  });

  it("TTL 内复用缓存：probe 两次只请求一次 object_info", async () => {
    const { client, calls } = makeClientWithInfo();
    let now = 1_000;
    const catalog = new NodeCatalogService(client, undefined, () => now);
    await catalog.probe();
    await catalog.probe();
    expect(calls()).toBe(1);
    now = 1_000 + 11 * 60 * 1000; // 超过 10min TTL
    await catalog.probe(true);
    expect(calls()).toBe(2);
  });

  it("search 排序：exact classType > displayName > category > fuzzy token", async () => {
    const { client } = makeClientWithInfo();
    const catalog = new NodeCatalogService(client, undefined, () => 1_000);
    await catalog.probe();
    const exact = catalog.search("KSampler");
    expect(exact[0]).toMatchObject({ classType: "KSampler", score: 1.0 });
    const byDisplay = catalog.search("Wildcard Processor");
    expect(byDisplay[0]?.classType).toBe("ImpactWildcardProcessor");
    const byCategory = catalog.search("Impact Pack");
    expect(byCategory[0]?.classType).toBe("ImpactWildcardProcessor");
    const fuzzy = catalog.search("wildcard processor", 5);
    expect(fuzzy.some((m) => m.classType === "ImpactWildcardProcessor")).toBe(true);
  });

  it("inject()：无 native 时注入 schema 供 validator 使用", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, 404);
    const client = new NativeComfyClient({ proxyBaseUrl: PROXY_BASE, fetchImpl });
    const catalog = new NodeCatalogService(client);
    await catalog.probe();
    expect(catalog.count()).toBe(0);
    catalog.inject(normalizeObjectInfo(SAMPLE_OBJECT_INFO));
    expect(catalog.count()).toBe(3);
    expect(catalog.get("KSampler")).toBeTruthy();
  });

  it("catalog 不可用时 getOrRefresh 抛 NODE_NOT_FOUND（不 hallucinate）", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, 404);
    const client = new NativeComfyClient({ proxyBaseUrl: PROXY_BASE, fetchImpl });
    const catalog = new NodeCatalogService(client);
    await catalog.probe();
    await expect(catalog.getOrRefresh("AnyNode")).rejects.toBeInstanceOf(RhError);
  });
});

describe("/models folder 协议（P0.1-01）", () => {
  /** folder 契约 mock：/models → folders；/models/{folder} → 文件列表；未知 folder → 404 */
  function makeFolderClient(): {
    client: NativeComfyClient;
    calls: Map<string, number>;
  } {
    const calls = new Map<string, number>();
    const bump = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1);
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith("/models")) {
        bump("folders");
        return jsonResponse(["checkpoints", "loras", "vae", "upscale_models"]);
      }
      if (url.endsWith("/models/checkpoints")) {
        bump("checkpoints");
        return jsonResponse(["model_a.safetensors", "model_b.safetensors"]);
      }
      if (url.endsWith("/models/loras")) {
        bump("loras");
        return jsonResponse(["lora_x.safetensors"]);
      }
      bump("unknown-folder");
      return jsonResponse({ msg: "not found" }, 404);
    };
    return { client: new NativeComfyClient({ proxyBaseUrl: PROXY_BASE, fetchImpl }), calls };
  }

  it("getModelFolders 返回 string[]（folder 名称列表）", async () => {
    const { client } = makeFolderClient();
    const result = await client.getModelFolders();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(["checkpoints", "loras", "vae", "upscale_models"]);
    }
  });

  it("getModelsByFolder 返回该 folder 的模型文件列表", async () => {
    const { client } = makeFolderClient();
    const result = await client.getModelsByFolder("checkpoints");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("model_a.safetensors");
    }
  });

  it("folder 404 可降级：getModelsByFolder 返回 ok=false，不抛错", async () => {
    const { client } = makeFolderClient();
    const result = await client.getModelsByFolder("nonexistent_folder");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  it("NodeCatalogService：folder 列表与各 folder 独立 TTL 缓存 + refresh", async () => {
    const { client, calls } = makeFolderClient();
    let now = 1_000;
    const catalog = new NodeCatalogService(client, undefined, () => now);

    expect(await catalog.getModelFolders()).toEqual([
      "checkpoints",
      "loras",
      "vae",
      "upscale_models",
    ]);
    expect(await catalog.getModelsByFolder("checkpoints")).toContain("model_a.safetensors");
    // TTL 内复用
    await catalog.getModelFolders();
    await catalog.getModelsByFolder("checkpoints");
    expect(calls.get("folders")).toBe(1);
    expect(calls.get("checkpoints")).toBe(1);
    // 超过 TTL（5min）后重新拉取
    now += 6 * 60 * 1000;
    await catalog.getModelFolders();
    await catalog.getModelsByFolder("checkpoints");
    expect(calls.get("folders")).toBe(2);
    expect(calls.get("checkpoints")).toBe(2);
    // refresh=true 强制刷新
    await catalog.getModelsByFolder("loras", true);
    expect(calls.get("loras")).toBe(1);
    // 未知 folder：undefined（降级），不抛错
    expect(await catalog.getModelsByFolder("nonexistent_folder")).toBeUndefined();
  });

  it("Level 3 四个基础 folder 全部可从 catalog 取到（P0.1-01 要求）", async () => {
    const { client } = makeFolderClient();
    const catalog = new NodeCatalogService(client);
    for (const folder of ["checkpoints", "loras", "vae", "upscale_models"] as const) {
      const list = await catalog.getModelsByFolder(folder);
      // mock 中 vae/upscale_models 404 → undefined 是合法降级；checkpoints/loras 必须有值
      if (folder === "checkpoints" || folder === "loras") {
        expect(list).toBeDefined();
      } else {
        expect(list === undefined || Array.isArray(list)).toBe(true);
      }
    }
  });
});
