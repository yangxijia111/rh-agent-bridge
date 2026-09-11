/**
 * Native capability probe（02_ARCHITECTURE.md §5）。
 *
 * 探测 /features → /object_info → /models（+ /object_info/{class} 单点）。
 * 记录成功 / 404 / 403 / timeout；capability=false 不算 doctor 失败（05 M7）。
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

  const [features, objectInfo, objectInfoByClass, models] = await Promise.all([
    client.getFeatures(),
    client.getObjectInfo(),
    client.getObjectInfoByClass(PROBE_CLASS),
    client.getModels(),
  ]);

  details.push(toDetail("/features", features));
  details.push(toDetail("/object_info", objectInfo));
  details.push(toDetail(`/object_info/${PROBE_CLASS}`, objectInfoByClass));
  details.push(toDetail("/models", models));

  const capabilities: NativeCapabilities = {
    features: features.ok,
    objectInfo: objectInfo.ok,
    objectInfoByClass: objectInfoByClass.ok,
    models: models.ok,
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
