import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseApiFormat } from "../../src/graph/parse.js";
import {
  validateConnectionsAgainstSchema,
  validateGraph,
} from "../../src/graph/validate.js";
import { normalizeObjectInfo } from "../../src/catalog/adapter.js";
import type { NodeDefinition, NodeSchemaLookup } from "../../src/catalog/nodes.js";

const CONTRACTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "contracts");

/** 用 contract fixture（comfy-object-info.json）构建 schema catalog */
function contractCatalog(): NodeSchemaLookup & { defs: NodeDefinition[] } {
  const raw = JSON.parse(readFileSync(path.join(CONTRACTS, "comfy-object-info.json"), "utf-8"));
  const defs = normalizeObjectInfo(raw);
  const map = new Map<string, NodeDefinition>(defs.map((d) => [d.classType, d]));
  return {
    defs,
    get: (classType: string) => map.get(classType),
    count: () => map.size,
  };
}

describe("P0.1-02：连接 schema 校验（validateConnectionsAgainstSchema）", () => {
  const catalog = contractCatalog();

  it("MODEL → MODEL PASS（CheckpointLoader[0] → KSampler.model）", () => {
    const graph = parseApiFormat({
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model_a.safetensors" } },
      "3": {
        class_type: "KSampler",
        inputs: {
          seed: 1,
          steps: 20,
          cfg: 8,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: 1,
          model: ["4", 0],
          positive: ["6", 0],
          negative: ["7", 0],
          latent_image: ["5", 0],
        },
      },
      "5": {
        class_type: "VAEDecode",
        inputs: { samples: ["5", 0], vae: ["4", 2] },
      },
      "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["4", 2] } },
      "7": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["4", 2] } },
    });
    const issues = validateConnectionsAgainstSchema(graph, catalog).filter(
      (i) => i.code === "CONNECTION_TYPE_MISMATCH" || i.code === "CONNECTION_NOT_ALLOWED",
    );
    // model: MODEL→MODEL 合法（latent_image 故意接 VAEDecode 会有 mismatch，过滤后 model 链路无 mismatch）
    expect(issues.some((i) => i.field === "model")).toBe(false);
  });

  it("MODEL → IMAGE FAIL（CheckpointLoader[0] → SaveImage.images）", () => {
    const graph = parseApiFormat({
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model_a.safetensors" } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["4", 0] } },
    });
    const issues = validateConnectionsAgainstSchema(graph, catalog);
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "CONNECTION_TYPE_MISMATCH",
        field: "images",
        details: {
          fromNode: "4",
          outputIndex: 0,
          sourceType: "MODEL",
          toNode: "9",
          field: "images",
          targetType: "IMAGE",
        },
      }),
    );
  });

  it("IMAGE → IMAGE PASS（VAEDecode[0] → SaveImage.images）", () => {
    const graph = parseApiFormat({
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model_a.safetensors" } },
      "8": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["4", 2] } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["8", 0] } },
    });
    const issues = validateConnectionsAgainstSchema(graph, catalog).filter(
      (i) => i.code === "CONNECTION_TYPE_MISMATCH",
    );
    expect(issues.filter((i) => i.field === "images")).toEqual([]);
  });

  it("连接写入 INT 字段 FAIL（→ KSampler.steps 报 CONNECTION_NOT_ALLOWED）", () => {
    const graph = parseApiFormat({
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model_a.safetensors" } },
      "3": {
        class_type: "KSampler",
        inputs: { steps: ["4", 0] },
      },
    });
    const issues = validateConnectionsAgainstSchema(graph, catalog);
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "CONNECTION_NOT_ALLOWED",
        field: "steps",
        message: expect.stringMatching(/INT primitive input/),
      }),
    );
  });

  it("outputIndex 越界 FAIL（CheckpointLoader[5] 不存在）", () => {
    const graph = parseApiFormat({
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model_a.safetensors" } },
      "3": { class_type: "KSampler", inputs: { model: ["4", 5] } },
    });
    const issues = validateConnectionsAgainstSchema(graph, catalog);
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "OUTPUT_INDEX_OUT_OF_RANGE",
        field: "model",
        message: expect.stringMatching(/index 5 out of range/),
      }),
    );
  });

  it("missing source node FAIL（Level 1 MISSING_UPSTREAM_NODE）", () => {
    const graph = parseApiFormat({
      "3": { class_type: "KSampler", inputs: { model: ["999", 0] } },
    });
    const result = validateGraph(graph);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "MISSING_UPSTREAM_NODE", field: "model" }),
    );
    // 连接校验不应对缺失上游再报类型错误
    expect(
      validateConnectionsAgainstSchema(graph, catalog).filter(
        (i) => i.code === "CONNECTION_TYPE_MISMATCH",
      ),
    ).toEqual([]);
  });

  it("custom datatype 无法判断 → warning（UNKNOWN_TYPE_COMPAT）而非 error", () => {
    const graph = parseApiFormat({
      "1": { class_type: "CustomNodeA", inputs: {} },
      "2": { class_type: "KSampler", inputs: { model: ["1", 0] } },
    });
    const catalogWithCustom = contractCatalog();
    (catalogWithCustom as unknown as { defs: NodeDefinition[] }).defs.push(
      {
        classType: "CustomNodeA",
        inputRequired: {},
        inputOptional: {},
        outputTypes: ["MY_CUSTOM_TYPE"],
      },
    );
    // CustomNodeA 未注册进 map —— 直接用 validateGraph + 扩展 catalog 重新构建
    const defs = [
      ...(catalogWithCustom as unknown as { defs: NodeDefinition[] }).defs,
    ];
    const map = new Map(defs.map((d) => [d.classType, d]));
    const extendedCatalog: NodeSchemaLookup = {
      get: (c) => map.get(c),
      count: () => map.size,
    };
    const issues = validateConnectionsAgainstSchema(graph, extendedCatalog);
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "UNKNOWN_TYPE_COMPAT",
        details: expect.objectContaining({ sourceType: "MY_CUSTOM_TYPE", targetType: "MODEL" }),
      }),
    );
    expect(issues.filter((i) => i.code === "CONNECTION_TYPE_MISMATCH")).toEqual([]);
  });

  it("validateGraph 集成：useNodeSchema 时连接校验自动生效", () => {
    const graph = parseApiFormat({
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model_a.safetensors" } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["4", 0] } },
    });
    const result = validateGraph(graph, { nodeSchemas: catalog });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "CONNECTION_TYPE_MISMATCH" }),
    );
  });
});
