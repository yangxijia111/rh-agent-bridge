/**
 * object_info → NodeDefinition 适配器（05 M7 Node schema adapter）。
 *
 * 把远端 ComfyUI object_info 规范化为内部 NodeDefinition，
 * 避免远端 schema 变化直接污染 domain。
 *
 * ComfyUI input spec 形态：
 *   ["STRING", { default, multiline, ... }]
 *   ["INT", { default, min, max, step }]
 *   [["euler", "ddim"]]                 ← COMBO（第一个元素是数组）
 *   ["MODEL", { tooltip }]              ← 连接类型
 */
import type { ObjectInfoRaw } from "../clients/comfy/schemas.js";
import type { NodeDefinition, NodeInputSpec } from "./nodes.js";

export function normalizeObjectInfo(raw: ObjectInfoRaw): NodeDefinition[] {
  const defs: NodeDefinition[] = [];
  for (const [classType, nodeRaw] of Object.entries(raw)) {
    const def: NodeDefinition = {
      classType: nodeRaw.name && nodeRaw.name !== "" ? nodeRaw.name : classType,
      ...(nodeRaw.display_name !== undefined ? { displayName: nodeRaw.display_name } : {}),
      ...(nodeRaw.category !== undefined ? { category: nodeRaw.category } : {}),
      inputRequired: {},
      inputOptional: {},
      outputTypes: nodeRaw.output ?? [],
      ...(nodeRaw.output_name !== undefined ? { outputNames: nodeRaw.output_name } : {}),
      ...(nodeRaw.output_node !== undefined ? { outputNode: nodeRaw.output_node } : {}),
    };
    for (const [field, spec] of Object.entries(nodeRaw.input?.required ?? {})) {
      const normalized = normalizeInputSpec(spec);
      if (normalized) def.inputRequired[field] = normalized;
    }
    for (const [field, spec] of Object.entries(nodeRaw.input?.optional ?? {})) {
      const normalized = normalizeInputSpec(spec);
      if (normalized) def.inputOptional[field] = normalized;
    }
    defs.push(def);
  }
  return defs;
}

function normalizeInputSpec(spec: unknown[]): NodeInputSpec | undefined {
  const first = spec[0];
  if (Array.isArray(first)) {
    // COMBO：选项数组
    return { type: "COMBO", options: first };
  }
  if (typeof first !== "string" || first === "") return undefined;
  const extrasRaw = spec[1];
  const extras =
    extrasRaw !== null && typeof extrasRaw === "object" && !Array.isArray(extrasRaw)
      ? (extrasRaw as Record<string, unknown>)
      : {};
  const out: NodeInputSpec = { type: first };
  if (typeof extras.min === "number") out.min = extras.min;
  if (typeof extras.max === "number") out.max = extras.max;
  if (typeof extras.step === "number") out.step = extras.step;
  if ("default" in extras) out.default = extras.default;
  return out;
}
