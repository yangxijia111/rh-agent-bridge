/**
 * 前端-only 字段（P0.1-04：共享 domain 模块）。
 *
 * 官方 nodeInfoList 文档明确：API Format 中找不到的 fieldName 可能属于纯前端字段，
 * control_after_generate 一类只在浏览器中有意义，group 相关不属于可执行部分。
 *
 * Service（run overrides 保护）与 BrowserFallback 共用此单一来源，
 * 不允许各自维护一份副本。
 */

/** 已知前端-only 字段集合（小写） */
export const FRONTEND_ONLY_FIELDS: ReadonlySet<string> = new Set([
  "control_after_generate",
  "group",
  "group_id",
  "collapsed",
  "mode",
]);

/** 判断字段是否前端-only */
export function isFrontendOnlyField(field: string): boolean {
  return FRONTEND_ONLY_FIELDS.has(field);
}
