import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/config/logger.js";

// AT-105 验收测试 fixture：假 API key（仅用于验证日志脱敏，非真实凭据）
const TEST_KEY = "abc123-secret";

describe("logger 脱敏（AT-105）", () => {
  it("日志输出不包含 API key，也不包含 proxy URL 中的 key", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      redaction: { secrets: [TEST_KEY] },
      sink: (line) => lines.push(line),
    });
    logger.info(`request https://www.runninghub.ai/proxy/${TEST_KEY}/object_info`, {
      apiKey: TEST_KEY,
      tool: "rh_nodes_probe",
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain(TEST_KEY);
    expect(joined).toContain("[REDACTED]");
    expect(joined).toContain("rh_nodes_probe");
  });

  it("child logger 继承脱敏", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      redaction: { secrets: [TEST_KEY] },
      sink: (line) => lines.push(line),
    }).child({ requestId: "r-1" });
    logger.error(`failed url=https://www.runninghub.ai/proxy/${TEST_KEY}/feature`, {
      errorCode: "NETWORK",
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain(TEST_KEY);
    expect(joined).toContain("r-1");
  });

  it("silent 级别不输出", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "silent",
      redaction: { secrets: [] },
      sink: (line) => lines.push(line),
    });
    logger.info("hello");
    expect(lines).toHaveLength(0);
  });
});
