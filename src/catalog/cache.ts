/**
 * Catalog 缓存与 NodeCatalogService（02 §13 缓存 TTL、05 M7、P0.1-01/P0.1-11）。
 *
 * TTL：object_info 10min / models(folder) 5min / features 30min。
 * 找不到 node 时强制 refresh 一次再返回 NODE_NOT_FOUND（AT-203）。
 *
 * P0.1-01：/models 只返回 folder 名称列表；具体模型文件按需
 * GET /models/{folder} 并独立 TTL 缓存（lazy loading，folder 404 可降级）。
 */
import type { Logger } from "../config/logger.js";
import { rhError } from "../errors.js";
import type { CapabilityProbeDetail, NativeCapabilities } from "../clients/comfy/capability.js";
import { probeCapabilities } from "../clients/comfy/capability.js";
import type { NativeComfyClient } from "../clients/comfy/client.js";
import type { ObjectInfoRaw } from "../clients/comfy/schemas.js";
import { normalizeObjectInfo } from "./adapter.js";
import {
  searchNodeDefinitions,
  type NodeDefinition,
  type NodeSchemaLookup,
} from "./nodes.js";

const OBJECT_INFO_TTL_MS = 10 * 60 * 1000;
const MODELS_TTL_MS = 5 * 60 * 1000;
const CAPABILITIES_TTL_MS = 30 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

export interface CatalogSnapshot {
  source: "native-comfy";
  count: number;
  capabilities: NativeCapabilities;
  cacheAgeMs: number;
  /** 每个端点的探测明细（P0.1-11；仅 path 与状态，绝无 API key） */
  probeDetails?: CapabilityProbeDetail[];
}

/** Level 3 校验至少支持的 folder（P0.1-01） */
export const LEVEL3_MODEL_FOLDERS = [
  "checkpoints",
  "loras",
  "vae",
  "upscale_models",
] as const;

export class NodeCatalogService implements NodeSchemaLookup {
  private objectInfoEntry: CacheEntry<Map<string, NodeDefinition>> | undefined;
  private capabilitiesEntry: CacheEntry<NativeCapabilities> | undefined;
  private lastProbeDetails: CapabilityProbeDetail[] | undefined;
  private modelFoldersEntry: CacheEntry<string[]> | undefined;
  private readonly modelFolderEntries = new Map<string, CacheEntry<string[]>>();
  /** 内存兜底（无 native 时也能由调用方注入 schema，例如测试） */
  private fallbackDefs = new Map<string, NodeDefinition>();

  constructor(
    private readonly comfy: NativeComfyClient,
    private readonly logger?: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  get(classType: string): NodeDefinition | undefined {
    return this.objectInfoEntry?.value.get(classType) ?? this.fallbackDefs.get(classType);
  }

  count(): number {
    return this.objectInfoEntry?.value.size ?? this.fallbackDefs.size;
  }

  all(): NodeDefinition[] {
    return [...(this.objectInfoEntry?.value.values() ?? [...this.fallbackDefs.values()])];
  }

  capabilities(): NativeCapabilities | undefined {
    return this.capabilitiesEntry?.value;
  }

  cacheAgeMs(): number {
    return this.objectInfoEntry ? this.now() - this.objectInfoEntry.fetchedAt : -1;
  }

  /** 注入式 schema（无 native 或测试场景） */
  inject(defs: NodeDefinition[]): void {
    for (const def of defs) this.fallbackDefs.set(def.classType, def);
  }

  /* ---------------- 模型目录（P0.1-01：lazy + TTL + 降级） ---------------- */

  /** folder 名称列表（GET /models）；不可用时返回 undefined，不抛错 */
  async getModelFolders(refresh = false): Promise<string[] | undefined> {
    const now = this.now();
    if (!refresh && this.modelFoldersEntry && now - this.modelFoldersEntry.fetchedAt < MODELS_TTL_MS) {
      return this.modelFoldersEntry.value;
    }
    const result = await this.comfy.getModelFolders();
    if (!result.ok) {
      this.logger?.warn("native /models unavailable; Level 3 model validation degraded", {
        status: result.status,
        error: result.error,
      });
      return this.modelFoldersEntry?.value; // 退回旧缓存（若有）
    }
    this.modelFoldersEntry = { value: result.data, fetchedAt: now };
    return result.data;
  }

  /** 指定 folder 的模型文件列表（GET /models/{folder}）；folder 不存在 → undefined */
  async getModelsByFolder(folder: string, refresh = false): Promise<string[] | undefined> {
    const now = this.now();
    const cached = this.modelFolderEntries.get(folder);
    if (!refresh && cached && now - cached.fetchedAt < MODELS_TTL_MS) {
      return cached.value;
    }
    const result = await this.comfy.getModelsByFolder(folder);
    if (!result.ok) {
      // folder 404 是合法降级路径：不同实例安装的 folder 集合不同
      this.logger?.debug("model folder unavailable", { folder, status: result.status });
      return cached?.value;
    }
    this.modelFolderEntries.set(folder, { value: result.data, fetchedAt: now });
    return result.data;
  }

  /* ---------------- probe ---------------- */

  /** 探测能力并（可选）加载 object_info（M7 + P0.1-11 details） */
  async probe(refresh = false): Promise<CatalogSnapshot> {
    const now = this.now();
    if (
      !refresh &&
      this.capabilitiesEntry &&
      now - this.capabilitiesEntry.fetchedAt < CAPABILITIES_TTL_MS
    ) {
      // capabilities 新鲜：object_info 若也新鲜则直接复用
      if (this.objectInfoEntry && now - this.objectInfoEntry.fetchedAt < OBJECT_INFO_TTL_MS) {
        return this.snapshot(this.capabilitiesEntry.value.objectInfo);
      }
    }
    const probeResult = await probeCapabilities(this.comfy);
    this.capabilitiesEntry = { value: probeResult.capabilities, fetchedAt: now };
    this.lastProbeDetails = probeResult.details;
    if (probeResult.objectInfoRaw !== undefined) {
      // 复用 probe 已拉取的完整 object_info，避免二次请求
      this.setObjectInfo(probeResult.objectInfoRaw);
    } else if (probeResult.capabilities.objectInfo) {
      await this.loadObjectInfo();
    } else if (!refresh) {
      this.logger?.warn("native /object_info unavailable; catalog falls back to injected schemas", {
        details: probeResult.details,
      });
    }
    return this.snapshot(probeResult.capabilities.objectInfo);
  }

  private setObjectInfo(raw: Record<string, unknown>): void {
    const defs = normalizeObjectInfo(raw as Parameters<typeof normalizeObjectInfo>[0]);
    const map = new Map<string, NodeDefinition>();
    for (const def of defs) map.set(def.classType, def);
    this.objectInfoEntry = { value: map, fetchedAt: this.now() };
  }

  private async loadObjectInfo(): Promise<boolean> {
    const result = await this.comfy.getObjectInfo();
    if (!result.ok) return false;
    this.setObjectInfo(result.data as ObjectInfoRaw);
    return true;
  }

  /**
   * 查找节点定义；找不到时强制 refresh 一次（AT-203）。
   * @throws rhError(NODE_NOT_FOUND)
   */
  async getOrRefresh(classType: string): Promise<NodeDefinition> {
    const direct = this.get(classType);
    if (direct) return direct;
    const loaded = await this.loadObjectInfo();
    const retried = this.get(classType);
    if (retried) return retried;
    throw rhError(
      "NODE_NOT_FOUND",
      loaded
        ? `node class "${classType}" not found in current /object_info catalog (refreshed)`
        : `node class "${classType}" not found; /object_info unavailable`,
      { classType, catalogCount: this.count() },
    );
  }

  search(query: string, limit = 10) {
    return searchNodeDefinitions(this.all(), query, limit);
  }

  private snapshot(loadedObjectInfo: boolean): CatalogSnapshot {
    const caps = this.capabilitiesEntry?.value;
    return {
      source: "native-comfy",
      count: this.count(),
      capabilities: caps ?? emptyCapabilities(),
      cacheAgeMs: this.cacheAgeMs(),
      ...(this.lastProbeDetails ? { probeDetails: this.lastProbeDetails } : {}),
      ...(loadedObjectInfo ? {} : { objectInfoLoaded: false }),
    } as CatalogSnapshot & { objectInfoLoaded?: boolean };
  }
}

function emptyCapabilities(): NativeCapabilities {
  return {
    features: false,
    objectInfo: false,
    objectInfoByClass: false,
    models: false,
    workflowTemplates: false,
    prompt: false,
    history: false,
    queue: false,
    websocket: false,
  };
}
