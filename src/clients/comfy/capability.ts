/**
 * Native capability probe（02_ARCHITECTURE.md §5）。
 *
 * 探测 /features → /object_info → /models（+ /object_info/{class} 单点）。
 * 记录成功 / 404 / 403 / timeout；capability=false 不算 doctor 失败（05 M7）。
 *
 * P0.1 语义：
 *  - models=true 仅表示 GET /models（folder 列表）成功，
 *    不代表已拿到任何具体模型文件（模型在 /models/{folder}，按需 lazy 拉取）。
 *  - details 完整保留（P0.1-11）：endpoint / ok / status / error，
 *    绝不包含含 API key 的完整 proxy URL（只有 path）。
 */
import type { NativeComfyClient } from "./client.js";

export interface NativeCapabilities {
  features: boolean;
  objectInfo: boolean;
  objectInfoByClass: boolean;
  models: boolean;
  workflowTemplates: boolean;
  prompt: boolean;
  history: boolean;
  queue: boolean;
  websocket: boolean;
}

export interface CapabilityProbeDetail {
  endpoint: string;
  ok: boolean;
  status: number;
  error?: string;
}

export interface CapabilityProbeResult {
  capabilities: NativeCapabilities;
  details: CapabilityProbeDetail[];
  /** 成功获取的完整 object_info（供 catalog 复用，避免二次请求） */
  objectInfoRaw?: Record<string, unknown>;
}

const PROBE_CLASS = "KSampler";

export async function probeCapabilities(
  client: NativeComfyClient,
): Promise<CapabilityProbeResult> {
  const details: CapabilityProbeDetail[] = [];

  const [features, objectInfo, objectInfoByClass, modelFolders] = await Promise.all([
    client.getFeatures(),
    client.getObjectInfo(),
    client.getObjectInfoByClass(PROBE_CLASS),
    client.getModelFolders(),
  ]);

  details.push(toDetail("/features", features));
  details.push(toDetail("/object_info", objectInfo));
  details.push(toDetail(`/object_info/${PROBE_CLASS}`, objectInfoByClass));
  details.push(toDetail("/models", modelFolders));

  const capabilities: NativeCapabilities = {
    features: features.ok,
    objectInfo: objectInfo.ok,
    objectInfoByClass: objectInfoByClass.ok,
    models: modelFolders.ok,
    // P0 不主动使用以下能力，标记为未探测
    workflowTemplates: false,
    prompt: false,
    history: false,
    queue: false,
    websocket: false,
  };
  return {
    capabilities,
    details,
    ...(objectInfo.ok ? { objectInfoRaw: objectInfo.data } : {}),
  };
}

function toDetail(
  endpoint: string,
  result: { ok: boolean; status: number; error?: string },
): CapabilityProbeDetail {
  return result.ok
    ? { endpoint, ok: true, status: result.status }
    : { endpoint, ok: false, status: result.status, error: result.error };
}
