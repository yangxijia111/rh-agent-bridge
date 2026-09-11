import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseApiFormat } from "../../src/graph/parse.js";
import { patchGraph } from "../../src/graph/mutate.js";
import { chooseExecutionMode, graphChangesToNodeInfoList } from "../../src/graph/execution.js";
import { emptyDiff } from "../../src/graph/types.js";
import { RhError } from "../../src/errors.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string) {
  return parseApiFormat(JSON.parse(readFileSync(path.join(FIXTURES, name), "utf-8")));
}

describe("chooseExecutionMode（AT-002 / AT-003）", () => {
  it("AT-002：仅 primitive 输入变化 → nodeInfoList", () => {
    const graph = loadFixture("basic-sdxl.json");
    const { diff } = patchGraph(graph, [{ type: "set_input", nodeId: "6", field: "text", value: "x" }]);
    expect(chooseExecutionMode(diff)).toBe("nodeInfoList");
  });

  it("AT-003：连接变化 → fullWorkflow", () => {
    const graph = loadFixture("with-custom-node.json");
    const { diff } = patchGraph(graph, [
      { type: "connect", fromNode: "4", outputIndex: 0, toNode: "3", input: "model" },
    ]);
    expect(chooseExecutionMode(diff)).toBe("fullWorkflow");
  });

  it("新增节点 → fullWorkflow", () => {
    const graph = loadFixture("basic-sdxl.json");
    const { diff } = patchGraph(graph, [{ type: "add_node", classType: "VAEDecode" }]);
    expect(chooseExecutionMode(diff)).toBe("fullWorkflow");
  });

  it("class type 变化 → fullWorkflow", () => {
    const diff = { ...emptyDiff(), classTypesChanged: true };
    expect(chooseExecutionMode(diff)).toBe("fullWorkflow");
  });

  it("无变化 → nodeInfoList（空覆盖，等价原模板运行）", () => {
    expect(chooseExecutionMode(emptyDiff())).toBe("nodeInfoList");
  });

  it("连接值被常量替换（非拓扑增删）→ fullWorkflow（禁止 nodeInfoList 改连接）", () => {
    const graph = loadFixture("basic-sdxl.json");
    const { diff } = patchGraph(graph, [
      { type: "set_input", nodeId: "3", field: "model", value: "checkpoint-name" },
    ]);
    expect(diff.topologyChanged).toBe(true); // 连接删除也会反映为 connectionsRemoved
    expect(chooseExecutionMode(diff)).toBe("fullWorkflow");
  });

  it("常量被连接值替换 → fullWorkflow", () => {
    const graph = loadFixture("with-image-input.json");
    const { diff } = patchGraph(graph, [
      { type: "set_input", nodeId: "1", field: "image", value: ["2", 0] },
    ]);
    expect(chooseExecutionMode(diff)).toBe("fullWorkflow");
  });
});

describe("graphChangesToNodeInfoList", () => {
  it("参数变化转换为官方 nodeInfoList 结构", () => {
    const graph = loadFixture("basic-sdxl.json");
    const { diff } = patchGraph(graph, [
      { type: "set_input", nodeId: "6", field: "text", value: "product photo" },
      { type: "set_input", nodeId: "3", field: "seed", value: 42 },
    ]);
    expect(graphChangesToNodeInfoList(diff)).toEqual([
      { nodeId: "3", fieldName: "seed", fieldValue: 42 },
      { nodeId: "6", fieldName: "text", fieldValue: "product photo" },
    ]);
  });

  it("拓扑变化时抛 UNSUPPORTED（05 M4：禁止转换）", () => {
    const graph = loadFixture("basic-sdxl.json");
    const { diff } = patchGraph(graph, [{ type: "add_node", classType: "X" }]);
    expect(() => graphChangesToNodeInfoList(diff)).toThrowError(
      Object.assign(expect.any(RhError), { code: "UNSUPPORTED" }) as unknown as Error,
    );
  });
});
