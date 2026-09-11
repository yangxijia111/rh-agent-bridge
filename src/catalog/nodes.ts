/**
 * Node Catalog（02_ARCHITECTURE.md §6）。
 *
 * NodeDefinition 是内部规范化的节点定义，不直接等于远端 object_info schema，
 * 避免 ComfyUI API 变化污染 domain（05 M7 要求）。
 * 数据源由 /object_info 动态获取（M7 的 adapter 填充），此处只定义 domain 类型与纯函数。
 */

/** 单个输入的规格 */
export interface NodeInputSpec {
  /**
   * 规格化类型：
   *  - 原始：STRING / INT / FLOAT / BOOLEAN
   *  - 连接：MODEL / CLIP / VAE / LATENT / IMAGE / MASK / CONDITIONING / CONTROL_NET / ...
   *  - COMBO：枚举选择（options 非空）
   */
  type: string;
  /** COMBO 的可选值 */
  options?: unknown[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
}

export interface NodeDefinition {
  classType: string;
  displayName?: string;
  category?: string;
  inputRequired: Record<string, NodeInputSpec>;
  inputOptional: Record<string, NodeInputSpec>;
  outputTypes: string[];
  outputNames?: string[];
  searchAliases?: string[];
  /** ComfyUI object_info 的 OUTPUT_NODE 标记（SaveImage 等终点节点） */
  outputNode?: boolean;
}

/** catalog 查询接口（validator 用；具体实现见 catalog/cache.ts） */
export interface NodeSchemaLookup {
  get(classType: string): NodeDefinition | undefined;
  count(): number;
}

/** 空实现：无 object_info 时 Level 2 校验自动跳过 */
export class EmptyNodeSchemaLookup implements NodeSchemaLookup {
  get(): undefined {
    return undefined;
  }
  count(): number {
    return 0;
  }
}

/** 判断 spec 是否为连接类型输入 */
export function isConnectionTypeSpec(spec: NodeInputSpec): boolean {
  if (spec.type === "COMBO") return false;
  return (
    spec.type !== "STRING" &&
    spec.type !== "INT" &&
    spec.type !== "FLOAT" &&
    spec.type !== "BOOLEAN"
  );
}

/* ---------------- node search（02 §6 排序规则） ---------------- */

export interface NodeSearchMatch {
  classType: string;
  displayName?: string;
  category?: string;
  score: number;
}

/**
 * 搜索排序：
 * 1. exact class type；
 * 2. display name 子串；
 * 3. search_aliases；
 * 4. category 子串；
 * 5. fuzzy token match。
 */
export function searchNodeDefinitions(
  catalog: NodeSchemaLookup | Iterable<NodeDefinition>,
  query: string,
  limit = 10,
): NodeSearchMatch[] {
  const defs = [...iterate(catalog)];
  const q = query.trim().toLowerCase();
  if (q === "") {
    return defs.slice(0, limit).map((d) => toMatch(d, 0));
  }
  const tokens = q.split(/\s+/);
  const scored: NodeSearchMatch[] = [];
  for (const def of defs) {
    const score = scoreDefinition(def, q, tokens);
    if (score > 0) scored.push(toMatch(def, score));
  }
  scored.sort((a, b) => b.score - a.score || a.classType.localeCompare(b.classType));
  return scored.slice(0, limit);
}

function* iterate(catalog: NodeSchemaLookup | Iterable<NodeDefinition>): Iterable<NodeDefinition> {
  if (Symbol.iterator in (catalog as Iterable<NodeDefinition>)) {
    yield* catalog as Iterable<NodeDefinition>;
  }
  // NodeSchemaLookup 无法枚举全部（当前实现不提供 list 接口），由调用方传 Iterable
}

function scoreDefinition(def: NodeDefinition, q: string, tokens: string[]): number {
  const classType = def.classType.toLowerCase();
  const displayName = (def.displayName ?? "").toLowerCase();
  const category = (def.category ?? "").toLowerCase();
  const aliases = (def.searchAliases ?? []).map((a) => a.toLowerCase());

  if (classType === q) return 1.0;
  if (displayName === q) return 0.95;
  if (aliases.includes(q)) return 0.9;
  if (classType.includes(q)) return 0.85;
  if (displayName.includes(q)) return 0.8;
  if (aliases.some((a) => a.includes(q))) return 0.7;
  if (category.includes(q)) return 0.6;
  // fuzzy token：所有 token 都命中任一字段
  const hay = `${classType} ${displayName} ${category} ${aliases.join(" ")}`;
  if (tokens.length > 1 && tokens.every((t) => hay.includes(t))) return 0.5;
  return 0;
}

function toMatch(def: NodeDefinition, score: number): NodeSearchMatch {
  return {
    classType: def.classType,
    ...(def.displayName !== undefined ? { displayName: def.displayName } : {}),
    ...(def.category !== undefined ? { category: def.category } : {}),
    score,
  };
}
