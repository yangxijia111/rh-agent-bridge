/**
 * Bridge 上下文组装：CLI 与 MCP 共用同一套 service 实例（05 M6 原则）。
 */
import { NodeCatalogService } from "../catalog/cache.js";
import { NativeComfyClient } from "../clients/comfy/client.js";
import { RunningHubClient } from "../clients/runninghub/client.js";
import { checkConfig, loadConfig, nativeProxyBaseUrl, type BridgeConfig } from "../config/env.js";
import { createLogger, type Logger } from "../config/logger.js";
import { HostBrowserAdapter } from "../browser/host-adapter.js";
import { SnapshotStore } from "./snapshots.js";
import { WorkflowService } from "./workflow.js";
import { TaskService } from "./task.js";
import { ResourceService } from "./resource.js";
import { BrowserFallbackService } from "./browser-fallback.js";

export interface BridgeContext {
  config: BridgeConfig;
  logger: Logger;
  rh: RunningHubClient;
  comfy: NativeComfyClient;
  catalog: NodeCatalogService;
  snapshots: SnapshotStore;
  workflow: WorkflowService;
  task: TaskService;
  resource: ResourceService;
  browserFallback: BrowserFallbackService;
}

export function createBridgeContext(env: NodeJS.ProcessEnv = process.env): BridgeContext {
  const config = loadConfig(env);
  const logger = createLogger({
    level: config.logLevel,
    redaction: { secrets: [config.apiKey] },
  });
  const rh = new RunningHubClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, logger });
  const comfy = new NativeComfyClient({
    proxyBaseUrl: nativeProxyBaseUrl(config),
    logger,
  });
  const catalog = new NodeCatalogService(comfy, logger);
  const snapshots = new SnapshotStore();
  const workflow = new WorkflowService(rh, catalog, snapshots, logger);
  const task = new TaskService(rh, logger);
  const resource = new ResourceService(rh);
  const browserFallback = new BrowserFallbackService(
    rh,
    snapshots,
    new HostBrowserAdapter(),
    logger,
  );
  return { config, logger, rh, comfy, catalog, snapshots, workflow, task, resource, browserFallback };
}

export { checkConfig };
