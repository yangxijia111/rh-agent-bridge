import { describe, expect, it } from "vitest";
import {
  redactJsonStringify,
  redactString,
  redactValue,
} from "../../src/config/redaction.js";

// AT-105 验收测试 fixture：假 API key（仅用于验证日志脱敏，非真实凭据）
const TEST_KEY = "abc123-secret";
const CONFIG = { secrets: [TEST_KEY] };

describe("redactString（AT-105 log redaction）", () => {
  it("隐藏 API key 明文", () => {
    const out = redactString(`calling with key=${TEST_KEY} now`, CONFIG);
    expect(out).not.toContain(TEST_KEY);
    expect(out).toContain("[REDACTED]");
  });

  it("隐藏 native proxy standard URL 中的 key", () => {
    const out = redactString(
      `GET https://www.runninghub.ai/proxy/${TEST_KEY}/object_info`,
      CONFIG,
    );
    expect(out).not.toContain(TEST_KEY);
    expect(out).toContain("/proxy/[REDACTED]");
  });

  it("隐藏 native proxy plus URL 中的 key", () => {
    const out = redactString(
      `GET https://www.runninghub.ai/proxy-plus/${TEST_KEY}/object_info`,
      CONFIG,
    );
    expect(out).not.toContain(TEST_KEY);
    expect(out).toContain("/proxy-plus/[REDACTED]");
  });

  it("隐藏未知 key 形式的 proxy 路径（key 未在 secrets 列表）", () => {
    const out = redactString("https://www.runninghub.ai/proxy/unknownkey123/models", { secrets: [] });
    expect(out).not.toContain("unknownkey123");
    expect(out).toContain("/proxy/[REDACTED]");
  });

  it("隐藏 Bearer token", () => {
    const out = redactString(`Authorization: Bearer ${TEST_KEY}`, CONFIG);
    expect(out).not.toContain(TEST_KEY);
  });

  it("隐藏 signed upload URL（X-Amz-Signature）", () => {
    const out = redactString(
      "upload to https://oss.example.com/bucket/api.safetensors?X-Amz-Signature=deadbeef123&X-Amz-Expires=600",
      CONFIG,
    );
    expect(out).not.toContain("deadbeef123");
    expect(out).toContain("[REDACTED]-SIGNED-URL");
  });

  it("长 secret 优先替换，避免短前缀残留", () => {
    const short = "abc123";
    const out = redactString(`key=${TEST_KEY} prefix=${short}`, {
      secrets: [short, TEST_KEY],
    });
    expect(out).not.toContain(short);
  });

  it("普通 URL 路径不受影响", () => {
    const out = redactString("POST https://www.runninghub.ai/task/openapi/create", CONFIG);
    expect(out).toBe("POST https://www.runninghub.ai/task/openapi/create");
  });
});

describe("redactValue", () => {
  it("对象中的敏感字段值被替换", () => {
    const out = redactValue(
      { apiKey: TEST_KEY, taskId: "123", nested: { Authorization: `Bearer ${TEST_KEY}` } },
      CONFIG,
    ) as Record<string, unknown>;
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.taskId).toBe("123");
    expect((out.nested as Record<string, unknown>).Authorization).toBe("[REDACTED]");
  });

  it("字符串字段内容也被 redact", () => {
    const out = redactValue(
      { url: `https://x/proxy/${TEST_KEY}/a` },
      CONFIG,
    ) as Record<string, unknown>;
    expect(out.url).not.toContain(TEST_KEY);
  });

  it("不修改原对象", () => {
    const original = { apiKey: TEST_KEY };
    redactValue(original, CONFIG);
    expect(original.apiKey).toBe(TEST_KEY);
  });
});

describe("redactJsonStringify", () => {
  it("序列化时脱敏且处理循环引用", () => {
    const obj: Record<string, unknown> = { apiKey: TEST_KEY };
    obj.self = obj;
    const out = redactJsonStringify(obj, CONFIG);
    expect(out).not.toContain(TEST_KEY);
    expect(out).toContain("[Circular]");
  });
});
