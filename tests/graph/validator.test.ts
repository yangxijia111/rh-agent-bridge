import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseApiFormat } from "../../src/graph/parse.js";
import { validateGraph } from "../../src/graph/validate.js";
import type { NodeDefinition, NodeSchemaLookup } from "../../src/catalog/nodes.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string) {
  return parseApiFormat(JSON.parse(readFileSync(path.join(FIXTURES, name), "utf-8")));
}

/** 测试用 mini object_info catalog */
class FakeCatalog implements NodeSchemaLookup {
  readonly defs = new Map<string, NodeDefinition>();
  constructor(defs: NodeDefinition[]) {
    for (const d of defs) this.defs.set(d.classType, d);
  }
  get(classType: string) {
    return this.defs.get(classType);
  }
  count() {
    return this.defs.size;
  }
}

const ksamplerDef: NodeDefinition = {
  classType: "KSampler",
  displayName: "KSampler",
  category: "sampling",
  inputRequired: {
    seed: { type: "INT", min: 0, max: 18446744073709551615 },
    steps: { type: "INT", min: 1, max: 100 },
    cfg: { type: "FLOAT" },
    sampler_name: { type: "COMBO", options: ["euler", "dpmpp_2m", "ddim"] },
    scheduler: { type: "COMBO", options: ["normal", "karras"] },
    denoise: { type: "FLOAT" },
    model: { type: "MODEL" },
    positive: { type: "CONDITIONING" },
    negative: { type: "CONDITIONING" },
    latent_image: { type: "LATENT" },
  },
  inputOptional: {},
  outputTypes: ["LATENT"],
};

const checkpointDef: NodeDefinition = {
  classType: "CheckpointLoaderSimple",
  displayName: "Load Checkpoint",
  category: "loaders",
  inputRequired: { ckpt_name: { type: "COMBO", options: ["sd_xl_base_1.0.safetensors"] } },
  inputOptional: {},
  outputTypes: ["MODEL", "CLIP", "VAE"],
};

const saveImageDef: NodeDefinition = {
  classType: "SaveImage",
  inputRequired: {
    filename_prefix: { type: "STRING" },
    images: { type: "IMAGE" },
  },
  inputOptional: {},
  outputTypes: [],
  outputNode: true,
};

describe("Level 1 结构校验", () => {
  it("正常 fixture 校验通过（仅 SCHEMA_UNAVAILABLE warning）", () => {
    const result = validateGraph(loadFixture("basic-sdxl.json"));
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("AT-004：broken-link → MISSING_UPSTREAM_NODE", () => {
    const result = validateGraph(loadFixture("broken-link.json"));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "MISSING_UPSTREAM_NODE",
        nodeId: "3",
        field: "model",
      }),
    );
  });

  it("AT-005：cycle → CYCLE_DETECTED", () => {
    const result = validateGraph(loadFixture("cycle.json"));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "CYCLE_DETECTED" }),
    );
  });

  it("自引用 → SELF_REFERENCE", () => {
    const result = validateGraph(
      parseApiFormat({
        "1": { class_type: "X", inputs: { self: ["1", 0] } },
        "9": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
      }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "SELF_REFERENCE", nodeId: "1" }),
    );
  });

  it("负数 outputIndex → INVALID_OUTPUT_INDEX", () => {
    const result = validateGraph(
      parseApiFormat({
        "1": { class_type: "X", inputs: {} },
        "2": { class_type: "Y", inputs: { a: ["1", -1] } },
      }),
    );
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "INVALID_OUTPUT_INDEX" }));
  });

  it("空图 → EMPTY_GRAPH", () => {
    const result = validateGraph({ nodes: {} });
    expect(result.issues[0]?.code).toBe("EMPTY_GRAPH");
  });
});

describe("Level 2 schema 校验", () => {
  const catalog = new FakeCatalog([ksamplerDef, checkpointDef, saveImageDef]);

  it("schema 齐备时正常 fixture 通过（补齐其余节点定义）", () => {
    const full = new FakeCatalog([
      ksamplerDef,
      checkpointDef,
      saveImageDef,
      {
        classType: "EmptyLatentImage",
        inputRequired: {
          width: { type: "INT" },
          height: { type: "INT" },
          batch_size: { type: "INT" },
        },
        inputOptional: {},
        outputTypes: ["LATENT"],
      },
      {
        classType: "CLIPTextEncode",
        inputRequired: { text: { type: "STRING" }, clip: { type: "CLIP" } },
        inputOptional: {},
        outputTypes: ["CONDITIONING"],
      },
      {
        classType: "VAEDecode",
        inputRequired: { samples: { type: "LATENT" }, vae: { type: "VAE" } },
        inputOptional: {},
        outputTypes: ["IMAGE"],
      },
    ]);
    const result = validateGraph(loadFixture("basic-sdxl.json"), { nodeSchemas: full });
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("未知 class type → NODE_NOT_FOUND（不 hallucinate）", () => {
    const result = validateGraph(loadFixture("basic-sdxl.json"), { nodeSchemas: catalog });
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "NODE_NOT_FOUND", message: expect.stringMatching(/EmptyLatentImage/) }),
    );
  });

  it("缺 required input → MISSING_REQUIRED_INPUT", () => {
    const graph = parseApiFormat({
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
      "3": {
        class_type: "KSampler",
        inputs: {
          // 缺 seed / steps / model 等
          cfg: 8,
        },
      },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
    });
    const result = validateGraph(graph, { nodeSchemas: catalog });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "MISSING_REQUIRED_INPUT", nodeId: "3", field: "seed" }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "MISSING_REQUIRED_INPUT", field: "model" }),
    );
  });

  it("类型错误：STRING 字段传 number → INVALID_INPUT_TYPE", () => {
    const graph = parseApiFormat({
      "3": {
        class_type: "KSampler",
        inputs: { seed: "not-a-number", steps: 20, cfg: 8, denoise: 1 },
      },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
    });
    const result = validateGraph(graph, { nodeSchemas: catalog });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "INVALID_INPUT_TYPE", field: "seed" }),
    );
  });

  it("COMBO 枚举外取值 → INVALID_ENUM_VALUE", () => {
    const graph = parseApiFormat({
      "3": {
        class_type: "KSampler",
        inputs: {
          seed: 1,
          steps: 20,
          cfg: 8,
          denoise: 1,
          sampler_name: "nonexistent_sampler",
        },
      },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
    });
    const result = validateGraph(graph, { nodeSchemas: catalog });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "INVALID_ENUM_VALUE", field: "sampler_name" }),
    );
  });

  it("INT 越界 → VALUE_OUT_OF_RANGE；非整数 → INVALID_INPUT_TYPE", () => {
    const graph = parseApiFormat({
      "3": {
        class_type: "KSampler",
        inputs: { seed: 1.5, steps: 500, cfg: 1.5, denoise: 1 },
      },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
    });
    const result = validateGraph(graph, { nodeSchemas: catalog });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "VALUE_OUT_OF_RANGE", field: "steps" }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "INVALID_INPUT_TYPE", field: "seed" }),
    );
  });

  it("连接类型字段收到常量 → CONNECTION_EXPECTED", () => {
    const graph = parseApiFormat({
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
      "3": {
        class_type: "KSampler",
        inputs: {
          seed: 1,
          steps: 20,
          cfg: 8,
          denoise: 1,
          model: "sd_xl_base_1.0.safetensors", // 应为连接
        },
      },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
    });
    const result = validateGraph(graph, { nodeSchemas: catalog });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "CONNECTION_EXPECTED", field: "model" }),
    );
  });

  it("无输出节点 → NO_OUTPUT_NODE", () => {
    const graph = parseApiFormat({
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
    });
    const result = validateGraph(graph, { nodeSchemas: catalog });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "NO_OUTPUT_NODE" }));
  });
});

describe("Level 3 model 校验", () => {
  it("checkpoint 不在列表 → MODEL_NOT_FOUND（默认 warning 不致命）", () => {
    const result = validateGraph(loadFixture("basic-sdxl.json"), {
      models: { checkpoints: ["other_model.safetensors"] },
    });
    expect(result.valid).toBe(true);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "MODEL_NOT_FOUND", field: "ckpt_name" }),
    );
  });

  it("strictModels=true 时升级为 error", () => {
    const result = validateGraph(loadFixture("basic-sdxl.json"), {
      models: { checkpoints: ["other_model.safetensors"] },
      strictModels: true,
    });
    expect(result.valid).toBe(false);
  });

  it("模型在列表中则无问题", () => {
    const result = validateGraph(loadFixture("basic-sdxl.json"), {
      models: { checkpoints: ["sd_xl_base_1.0.safetensors"] },
    });
    expect(result.issues.filter((i) => i.code === "MODEL_NOT_FOUND")).toEqual([]);
  });
});
