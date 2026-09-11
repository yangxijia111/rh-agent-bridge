/**
 * Workflow snapshot 存储（02 §14、05 快照策略）。
 *
 * 路径：<home>/.rh-agent/snapshots/<safeId>.<timestamp>.<sha256前8位>.json
 *
 * 触发时机（05）：
 *  - full workflow run 之前
 *  - browser fallback mutation 之前（强制，AT-402）
 *  - recorder（P2）
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface SnapshotRecord {
  workflowId: string;
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

  /** 保存 workflow 快照；失败抛错（调用方不得在快照失败后继续 browser mutation） */
  async saveWorkflowSnapshot(
    workflowId: string,
    apiFormatJson: Record<string, unknown>,
    now: () => Date = () => new Date(),
  ): Promise<SnapshotRecord> {
    const serialized = JSON.stringify(apiFormatJson, null, 2);
    const shaPrefix = createHash("sha256").update(serialized).digest("hex").slice(0, 8);
    const timestamp = now().toISOString().replace(/[:.]/g, "-");
    // workflowId 消毒：白名单字符，防止路径穿越
    const safeId = sanitizeFileToken(workflowId);
    const safeTimestamp = sanitizeFileToken(timestamp);
    const fileName = `${safeId}.${safeTimestamp}.${shaPrefix}.json`;
    // 边界校验：拼接结果必须仍位于 baseDir 内
    const target = path.resolve(this.baseDir, fileName);
    const root = path.resolve(this.baseDir);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`snapshot path escaped base directory: ${fileName}`);
    }
    await mkdir(root, { recursive: true });
    await writeFile(target, serialized, "utf-8");
    return { workflowId, filePath: target, savedAt: now().toISOString() };
  }
}

/** 只允许字母数字、连字符、下划线、点号（点号不许开头） */
function sanitizeFileToken(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.replace(/^\.+/, "_");
}
