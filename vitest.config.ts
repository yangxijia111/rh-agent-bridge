import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // 集成测试默认关闭，必须显式 RUN_INTEGRATION_TESTS=1 才运行（AT-D 节要求）
    exclude: ["tests/integration/**", "node_modules/**", "dist/**"],
  },
});
