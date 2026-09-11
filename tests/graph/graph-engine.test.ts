import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseApiFormat } from "../../src/graph/parse.js";
import { serializeApiFormat } from "../../src/graph/serialize.js";
import { listNodes, findNodes, nodeConnections } from "../../src/graph/inspect.js";
import { extractConnections, isConnectionValue, detectCycleNodes } from "../../src/graph/topology.js";
import { patchGraph, nextNodeId } from "../../src/graph/mutate.js";
import { diffGraphs } from "../../src/graph/diff.js";
import { RhError } from "../../src/errors.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string) {
  return parseApiFormat(JSON.parse(readFileSync(path.join(FIXTURES, name), "utf-8")));
}

describe("parseApiFormat / serializeApiFormat", () => {
  it("AT-001：解析基本 workflow（2 节点 1 连接）", () => {
    const graph = parseApiFormat({
      "4": { class_type: "CheckpointLoaderSimple", inputs: {} },
      "3": {
        class_type: "KSampler",
        inputs: { model: ["4", 0], steps: 20 },
      },
    });
    expect(Object.keys(graph.nodes)).toHaveLength(2);
    expect(extractConnections(graph)).toEqual([
      { fromNode: "4", outputIndex: 0, toNode: "3", inputName: "model" },
    ]);
    expect(graph.nodes["3"]!.inputs.steps).toBe(20);
  });

  it("解析 basic-sdxl：title 来自 _meta.title", () => {
    const graph = loadFixture("basic-sdxl.json");
    expect(graph.nodes["3"]!.classType).toBe("KSampler");
    expect(graph.nodes["6"]!.title).toBe("Positive Prompt");
    expect(listNodes(graph)).toHaveLength(7);
  });

  it("round-trip：parse → serialize 保持语义一致", () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURES, "basic-sdxl.json"), "utf-8"));
    const graph = parseApiFormat(raw);
    const out = serializeApiFormat(graph);
    expect(parseApiFormat(out)).toEqual(graph);
  });

  it("非法结构抛 INVALID_WORKFLOW（AT-102 同类）", () => {
    expect(() => parseApiFormat("not-json")).toThrowError(RhError);
    expect(() => parseApiFormat({ "3": { class_type: "", inputs: {} } })).toThrowError(/invalid/i);
    expect(() => parseApiFormat([1, 2])).toThrowError(/object/i);
  });
});

describe("inspect", () => {
  it("findNodes 按 classType / title 搜索（US-02）", () => {
    const graph = loadFixture("basic-sdxl.json");
    expect(findNodes(graph, "KSampler").map((n) => n.id)).toEqual(["3"]);
    expect(findNodes(graph, "Positive Prompt").map((n) => n.id)).toEqual(["6"]);
    expect(findNodes(graph, "clip").map((n) => n.id)).toEqual(["6", "7"]);
    expect(findNodes(graph, "").length).toBe(7);
  });

  it("toNodeView 分离常量输入与连接", () => {
    const graph = loadFixture("basic-sdxl.json");
    const view = listNodes(graph).find((n) => n.id === "3")!;
    expect(view.inputs.steps).toBe(20);
    expect(view.connections).toContainEqual({ input: "model", fromNode: "4", outputIndex: 0 });
  });

  it("nodeConnections 区分入边出边", () => {
    const graph = loadFixture("basic-sdxl.json");
    const { incoming, outgoing } = nodeConnections(graph, "4");
    expect(incoming).toHaveLength(0);
    expect(outgoing.length).toBe(4); // model + positive clip + negative clip + vae
  });
});

describe("mutate：set_input（AT-002）", () => {
  it("修改 primitive 输入 → topologyChanged=false", () => {
    const original = loadFixture("basic-sdxl.json");
    const result = patchGraph(original, [
      { type: "set_input", nodeId: "6", field: "text", value: "product photography" },
      { type: "set_input", nodeId: "3", field: "seed", value: 42 },
    ]);
    expect(result.graph.nodes["6"]!.inputs.text).toBe("product photography");
    expect(result.graph.nodes["3"]!.inputs.seed).toBe(42);
    expect(result.diff.topologyChanged).toBe(false);
    expect(result.diff.inputsChanged).toEqual([
      { nodeId: "3", field: "seed", before: 156680208700286, after: 42 },
      {
        nodeId: "6",
        field: "text",
        before: "beautiful scenery nature glass bottle landscape, purple Galaxy bottle",
        after: "product photography",
      },
    ]);
  });

  it("不可变：原 graph 不被修改", () => {
    const original = loadFixture("basic-sdxl.json");
    patchGraph(original, [{ type: "set_input", nodeId: "3", field: "steps", value: 99 }]);
    expect(original.nodes["3"]!.inputs.steps).toBe(20);
  });

  it("nodeId 不存在 → NODE_NOT_FOUND", () => {
    const graph = loadFixture("basic-sdxl.json");
    expect(() =>
      patchGraph(graph, [{ type: "set_input", nodeId: "777", field: "text", value: "x" }]),
    ).toThrowError(
      Object.assign(expect.any(RhError), { code: "NODE_NOT_FOUND" }) as unknown as Error,
    );
  });

  it("把连接字段改成常量 → 产生 CONNECTION_REPLACED_BY_VALUE warning", () => {
    const graph = loadFixture("basic-sdxl.json");
    const result = patchGraph(graph, [
      { type: "set_input", nodeId: "3", field: "model", value: "not-a-model" },
    ]);
    expect(
      result.warnings.some((w) => w.code === "CONNECTION_REPLACED_BY_VALUE"),
    ).toBe(true);
  });
});

describe("mutate：add_node / remove_node", () => {
  it("add_node 分配 max(数字 id)+1 并返回实际 id", () => {
    const graph = loadFixture("basic-sdxl.json"); // max id = 9
    const result = patchGraph(graph, [
      { type: "add_node", classType: "VAEDecode", inputs: {}, title: "Extra Decode" },
    ]);
    const newId = result.assignedNodeIds["#0"];
    expect(newId).toBe("10");
    expect(result.graph.nodes["10"]!.classType).toBe("VAEDecode");
    expect(result.graph.nodes["10"]!.title).toBe("Extra Decode");
    expect(result.diff.topologyChanged).toBe(true);
    expect(result.diff.nodesAdded).toEqual(["10"]);
  });

  it("nextNodeId 处理非数字 id 混排", () => {
    const graph = parseApiFormat({
      abc: { class_type: "X", inputs: {} },
      "5": { class_type: "Y", inputs: {} },
    });
    expect(nextNodeId(graph)).toBe("6");
  });

  it("显式 nodeId 冲突 → INVALID_WORKFLOW", () => {
    const graph = loadFixture("basic-sdxl.json");
    expect(() =>
      patchGraph(graph, [{ type: "add_node", nodeId: "3", classType: "X" }]),
    ).toThrowError(RhError);
  });

  it("remove_node 有下游连接 → NODE_IN_USE（04 §8）", () => {
    const graph = loadFixture("basic-sdxl.json");
    expect(() => patchGraph(graph, [{ type: "remove_node", nodeId: "4" }])).toThrowError(
      Object.assign(expect.any(RhError), { code: "NODE_IN_USE" }) as unknown as Error,
    );
  });

  it("remove_node 无下游 → 成功且 diff.nodesRemoved", () => {
    const graph = loadFixture("basic-sdxl.json");
    const result = patchGraph(graph, [{ type: "remove_node", nodeId: "9" }]);
    expect(result.graph.nodes["9"]).toBeUndefined();
    expect(result.diff.nodesRemoved).toEqual(["9"]);
  });
});

describe("mutate：connect / disconnect（AT-003）", () => {
  it("connect 改变连接 → topologyChanged=true", () => {
    const graph = loadFixture("with-custom-node.json");
    const result = patchGraph(graph, [
      { type: "connect", fromNode: "4", outputIndex: 0, toNode: "3", input: "model" },
    ]);
    expect(result.graph.nodes["3"]!.inputs.model).toEqual(["4", 0]);
    expect(result.diff.topologyChanged).toBe(true);
    expect(result.diff.connectionsAdded).toEqual([
      { fromNode: "4", outputIndex: 0, toNode: "3", inputName: "model" },
    ]);
    expect(result.diff.connectionsRemoved).toEqual([
      { fromNode: "1", outputIndex: 0, toNode: "3", inputName: "model" },
    ]);
  });

  it("connect 引用不存在的节点 → NODE_NOT_FOUND", () => {
    const graph = loadFixture("basic-sdxl.json");
    expect(() =>
      patchGraph(graph, [
        { type: "connect", fromNode: "999", outputIndex: 0, toNode: "3", input: "model" },
      ]),
    ).toThrowError(RhError);
  });

  it("connect 自引用 → INVALID_WORKFLOW", () => {
    const graph = loadFixture("basic-sdxl.json");
    expect(() =>
      patchGraph(graph, [
        { type: "connect", fromNode: "3", outputIndex: 0, toNode: "3", input: "model" },
      ]),
    ).toThrowError(/self/i);
  });

  it("disconnect 删除输入并带 warning（无 schema 路径，02 §7）", () => {
    const graph = loadFixture("basic-sdxl.json");
    const result = patchGraph(graph, [
      { type: "disconnect", toNode: "8", input: "vae" },
    ]);
    expect(result.graph.nodes["8"]!.inputs.vae).toBeUndefined();
    expect(result.diff.topologyChanged).toBe(true);
    expect(
      result.warnings.some((w) => w.code === "DISCONNECT_WITHOUT_SCHEMA"),
    ).toBe(true);
  });
});

describe("diffGraphs（04 §14）", () => {
  it("空操作 diff 为空", () => {
    const graph = loadFixture("basic-sdxl.json");
    const diff = diffGraphs(graph, graph);
    expect(diff.topologyChanged).toBe(false);
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.inputsChanged).toEqual([]);
  });

  it("组合操作输出完整 diff", () => {
    const before = loadFixture("basic-sdxl.json");
    const after = patchGraph(before, [
      { type: "set_input", nodeId: "3", field: "steps", value: 30 },
      { type: "add_node", classType: "ImageUpscaleWithModel" },
      { type: "connect", fromNode: "8", outputIndex: 0, toNode: "10", input: "upscale_model" },
    ]).graph;
    const diff = diffGraphs(before, after);
    expect(diff.topologyChanged).toBe(true);
    expect(diff.nodesAdded).toEqual(["10"]);
    expect(diff.inputsChanged).toEqual([
      { nodeId: "3", field: "steps", before: 20, after: 30 },
    ]);
  });
});

describe("topology", () => {
  it("isConnectionValue 形态判断", () => {
    expect(isConnectionValue(["4", 0])).toBe(true);
    expect(isConnectionValue(["4", -1])).toBe(false);
    expect(isConnectionValue(["4"])).toBe(false);
    expect(isConnectionValue([4, "0"])).toBe(false);
    expect(isConnectionValue("text")).toBe(false);
  });

  it("detectCycleNodes 识别 cycle fixture（AT-005 前置）", () => {
    const graph = loadFixture("cycle.json");
    const cycle = detectCycleNodes(graph);
    expect(cycle.sort()).toEqual(["A", "B"]);
  });

  it("无环图返回空", () => {
    const graph = loadFixture("basic-sdxl.json");
    expect(detectCycleNodes(graph)).toEqual([]);
  });
});
