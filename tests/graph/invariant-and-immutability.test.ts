import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseApiFormat } from "../../src/graph/parse.js";
import { serializeApiFormat } from "../../src/graph/serialize.js";
import { patchGraph, nextNodeId } from "../../src/graph/mutate.js";
import { graphFromWire, graphFromUnknown } from "../../src/tools/schemas.js";
import { RhError } from "../../src/errors.js";
import { workflowGraphJsonSchema } from "../../src/tools/schemas.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string) {
  return parseApiFormat(JSON.parse(readFileSync(path.join(FIXTURES, name), "utf-8")));
}

describe("P0.1-05：WorkflowGraph key/id invariant（方案 A：boundary 强校验，不静默纠正）", () => {
  it("wire key/id 不一致 → INVALID_WORKFLOW", () => {
    const wire = workflowGraphJsonSchema.parse({
      nodes: {
        "3": { id: "9", classType: "X", inputs: {} },
      },
    });
    expect(() => graphFromWire(wire)).toThrowError(
      Object.assign(expect.any(RhError), { code: "INVALID_WORKFLOW" }) as unknown as Error,
    );
  });

  it("两个 node.id 相同（不同 key）→ 拒绝（wire 层先命中 mismatch 规则，serialize 层命中 duplicate 规则）", () => {
    // wire 层：key=4 的节点 id="3" → mismatch 先触发（key≠id 必然先于 duplicate 成立）
    const wire = workflowGraphJsonSchema.parse({
      nodes: {
        "3": { id: "3", classType: "X", inputs: {} },
        "4": { id: "3", classType: "Y", inputs: {} }, // 与 key=3 的节点 id 冲突
      },
    });
    expect(() => graphFromWire(wire)).toThrowError(
      Object.assign(expect.any(RhError), { code: "INVALID_WORKFLOW" }) as unknown as Error,
    );
    // serialize 层：同一损坏形态同样被拒绝（mismatch 规则先触发；
    // duplicate 规则在 key===id 仍成立时提供纯防御兜底）
    const graph = parseApiFormat({
      "1": { class_type: "A", inputs: {} },
      "2": { class_type: "B", inputs: {} },
    });
    (graph.nodes["2"] as unknown as { id: string }).id = "1"; // id 与节点 1 相同
    expect(() => serializeApiFormat(graph)).toThrowError(
      Object.assign(expect.any(RhError), { code: "INVALID_WORKFLOW" }) as unknown as Error,
    );
  });

  it("serialize 拒绝 invariant 破损的 graph（不允许静默覆盖）", () => {
    // 直接构造绕过 boundary 的破损 graph（模拟内部逻辑错误被兜底拦截）
    const graph = parseApiFormat({
      "1": { class_type: "A", inputs: {} },
      "2": { class_type: "B", inputs: {} },
    });
    (graph.nodes["2"] as { id: string }).id = "1"; // 篡改 id → serialize 若用 id 作 key 会覆盖
    expect(() => serializeApiFormat(graph)).toThrowError(
      Object.assign(expect.any(RhError), { code: "INVALID_WORKFLOW" }) as unknown as Error,
    );
  });

  it("parse API Format 始终保持 key === id", () => {
    const graph = loadFixture("basic-sdxl.json");
    for (const [key, node] of Object.entries(graph.nodes)) {
      expect(node.id).toBe(key);
    }
  });

  it("patch add_node 始终保持 invariant（新节点 key === id）", () => {
    const graph = loadFixture("basic-sdxl.json");
    const result = patchGraph(graph, [
      { type: "add_node", classType: "ImageUpscaleWithModel" },
      { type: "connect", fromNode: "8", outputIndex: 0, toNode: nextNodeId(graph), input: "image" },
    ]);
    for (const [key, node] of Object.entries(result.graph.nodes)) {
      expect(node.id).toBe(key);
    }
    // serialize 仍然成功（invariant 完好）
    expect(() => serializeApiFormat(result.graph)).not.toThrow();
  });

  it("graphFromUnknown 接受 API Format 原样对象且保持 invariant", () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURES, "with-image-input.json"), "utf-8"));
    const graph = graphFromUnknown(raw);
    for (const [key, node] of Object.entries(graph.nodes)) {
      expect(node.id).toBe(key);
    }
  });
});

describe("P0.1-09：Graph mutation 真正 immutable（structuredClone 深拷贝）", () => {
  it("嵌套 object/array 修改不回写 original（set_input 写入嵌套值）", () => {
    const original = loadFixture("with-custom-node.json");
    const nested = { foo: { bar: [1, 2, 3] } };
    const result = patchGraph(original, [
      { type: "set_input", nodeId: "6", field: "text", value: nested },
    ]);
    // 修改新 graph 中的嵌套结构
    const written = result.graph.nodes["6"]!.inputs.text as typeof nested;
    written.foo.bar.push(99);
    written.foo.baz = "new-key";
    expect(nested.foo.bar).toEqual([1, 2, 3]);
    expect("baz" in nested.foo).toBe(false);
    // original 完全未动
    expect(original.nodes["6"]!.inputs.text).toBe("studio product photography");
  });

  it("original graph 中已有的嵌套输入在 patch 后不被共享引用", () => {
    // with-image-input 的 LoadImage.upload 是字符串；构造一个带嵌套输入的图
    const original = parseApiFormat({
      "1": {
        class_type: "SomeNode",
        inputs: { config: { list: [1, 2], inner: { deep: true } } },
      },
    });
    const result = patchGraph(original, [
      { type: "set_input", nodeId: "1", field: "other", value: 1 },
    ]);
    const before = original.nodes["1"]!.inputs.config as { list: number[] };
    const after = result.graph.nodes["1"]!.inputs.config as { list: number[] };
    expect(after).not.toBe(before); // 深拷贝：引用不同
    (after as { list: number[] }).list.push(999);
    expect(before.list).toEqual([1, 2]); // 原图不受影响
  });

  it("add_node 的 inputs 嵌套对象同样深拷贝", () => {
    const original = loadFixture("basic-sdxl.json");
    const shared = { arr: [1] };
    const result = patchGraph(original, [
      { type: "add_node", classType: "X", inputs: { payload: shared } },
    ]);
    const stored = result.graph.nodes["10"]!.inputs.payload as { arr: number[] };
    stored.arr.push(2);
    expect(shared.arr).toEqual([1]);
  });
});
