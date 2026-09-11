/**
 * Secret 脱敏（01_PRD.md FR-02 / 08 安全要求）。
 *
 * 任何要写入日志的字符串（URL、错误消息、对象序列化结果）
 * 都必须先经过本模块处理。
 *
 * 必须脱敏的目标：
 *  - API key 明文
 *  - Authorization: Bearer <token>
 *  - Native proxy URL 中的 /proxy/<key> 与 /proxy-plus/<key>
 *  - signed upload URL
 */

export interface RedactionConfig {
  /** 已知需要隐藏的 secret 值（API key 等） */
  secrets: string[];
  /** signed URL 等整体需要隐藏的 URL 前缀 */
  secretUrlPrefixes?: string[];
}

export const REDACTED = "[REDACTED]";

/** 收集常见敏感字段名（用于对象级 redact 的 path 匹配） */
const SENSITIVE_KEY_PATTERN =
  /^(authorization|api[-_]?key|apikey|token|secret|password|access[-_]?password|cookie)$/i;

/**
 * 对任意字符串做脱敏：
 * 1. 逐个替换已知 secret 明文；
 * 2. mask /proxy/<key> 与 /proxy-plus/<key>（key 在 path 里）；
 * 3. mask Bearer token；
 * 4. mask signed upload URL（query 里带签名的常见形式）。
 */
export function redactString(text: string, config: RedactionConfig): string {
  let out = text;
  // 长 secret 优先替换，避免短前缀先匹配造成残留
  const secrets = [...config.secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    out = out.split(secret).join(REDACTED);
  }
  // /proxy/<key> 与 /proxy-plus/<key>：key 可能与已知 secret 一致，也可能是别的形式
  out = out.replace(/\/proxy-plus\/[A-Za-z0-9._~+=-]+/g, `/proxy-plus/${REDACTED}`);
  out = out.replace(/\/proxy\/[A-Za-z0-9._~+=-]+/g, `/proxy/${REDACTED}`);
  // Bearer token
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+=/-]+/gi, `Bearer ${REDACTED}`);
  // signed upload URL：任何带 X-Amz-Signature / Signature / Expires 签名参数的 URL
  out = out.replace(
    /https?:\/\/[^\s"'<>]+(?:[?&](?:X-Amz-Signature|Signature|signature|sig)=)[^\s"'<>]+/g,
    `${REDACTED}-SIGNED-URL`,
  );
  // 显式传入的敏感 URL 前缀
  for (const prefix of config.secretUrlPrefixes ?? []) {
    if (prefix.length > 0 && out.includes(prefix)) {
      out = out.split(prefix).join(`${REDACTED}-URL`);
    }
  }
  return out;
}

/** 递归 redact 对象中的敏感字段值与字符串内容，返回安全副本（不修改原对象） */
export function redactValue(value: unknown, config: RedactionConfig, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value, config);
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, config, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : redactValue(v, config, depth + 1);
    }
    return out;
  }
  return value;
}

/** 把任意值安全序列化为 redact 后的字符串（日志兜底用） */
export function redactJsonStringify(value: unknown, config: RedactionConfig): string {
  try {
    return redactString(JSON.stringify(value, replacerWithoutCircular()), config);
  } catch {
    return redactString(String(value), config);
  }
}

function replacerWithoutCircular() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (value !== null && typeof value === "object") {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
    }
    return value;
  };
}
