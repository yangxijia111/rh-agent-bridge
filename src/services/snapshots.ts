/**
 * Workflow snapshot 存储（02 §14、05 快照策略、P0.1-03 语义）。
 *
 * 两种快照（P0.1-03）：
 *  - baseline：RunningHub 远端当前状态（rollback 依据）——full workflow run /
 *    browser fallback 变更前必须保存，且必须来自远端 fetch，而非本地候选 graph；
 *  - candidate：即将提交/执行的候选状态（可选保存，便于审计对比）。
 *
 * 路径：<home>/.rh-agent/snapshots/<safeId>.<kind>.<timestamp>.<sha256前8位>.json
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type SnapshotKind = "baseline" | "candidate";

export interface SnapshotRecord {
  workflowId: string;
  /** P0.1-03：baseline=远端当前态（rollback 依据）；candidate=即将提交的候选态 */
  kind: SnapshotKind;
  filePath: string;
  savedAt: string;
}

export class SnapshotStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    // 固定常量目录；跨平台分隔符统一交给 normalize
    this.baseDir = path.normalize(
      baseDir !== undefined ? baseDir : `${homedir()}${path.sep}.rh-agent${path.sep}snapshots`,
    );
  }

  /** 保存快照；失败抛错（调用方不得在快照失败后继续 mutation/run/browser 变更） */
  async saveWorkflowSnapshot(
    workflowId: string,
    kind: SnapshotKind,
    apiFormatJson: Record<string, unknown>,
    now: () => Date = () => new Date(),
  ): Promise<SnapshotRecord> {
    const serialized = JSON.stringify(apiFormatJson, null, 2);
    const shaPrefix = createHash("sha256").update(serialized).digest("hex").slice(0, 8);
    const timestamp = now().toISOString().replace(/[:.]/g, "-");
    // workflowId / kind 消毒：白名单字符，防止路径穿越
    const safeId = sanitizeFileToken(workflowId);
    const safeKind = sanitizeFileToken(kind);
    const fileName = `${safeId}.${safeKind}.${timestamp}.${shaPrefix}.json`;
    // 边界校验：拼接结果必须仍位于 baseDir 内
    const target = path.resolve(this.baseDir, fileName);
    const root = path.resolve(this.baseDir);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`snapshot path escaped base directory: ${fileName}`);
    }
    await mkdir(root, { recursive: true });
    await writeFile(target, serialized, "utf-8");
    return { workflowId, kind, filePath: target, savedAt: now().toISOString() };
  }
}

/** 只允许字母数字、连字符、下划线、点号（点号不许开头） */
function sanitizeFileToken(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.replace(/^\.+/, "_");
}
