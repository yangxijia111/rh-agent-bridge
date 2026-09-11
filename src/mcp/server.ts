/**
 * MCP Server（05 M6）：把 TOOL_REGISTRY 暴露为 MCP tools（stdio transport）。
 *
 * 与 CLI 共用同一 service 层（05：CLI 和 MCP 不允许各写一套业务逻辑）。
 * 注意：stdout 是 MCP 协议通道，所有日志必须走 stderr（logger 默认 sink）。
 */
import type { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toRhError } from "../errors.js";
import { createBridgeContext, type BridgeContext } from "../services/context.js";
import { TOOL_REGISTRY } from "../tools/registry.js";

/** 构建 MCP server（测试可注入自定义 context / transport） */
export function buildMcpServer(ctx: BridgeContext): McpServer {
  const server = new McpServer({ name: "rh-agent-bridge", version: "0.1.1" });

  for (const tool of TOOL_REGISTRY) {
    const objectSchema = tool.schema as unknown as z.ZodObject<z.ZodRawShape>;
    server.tool(
      tool.name,
      tool.description,
      objectSchema.shape,
      async (rawArgs: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
        let input: unknown;
        try {
          input = tool.schema.parse(rawArgs);
        } catch (err) {
          const parseMessage =
            err instanceof Error ? err.message : "input schema validation failed";
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: {
                    code: "INVALID_WORKFLOW",
                    message: `invalid input for ${tool.name}: ${parseMessage}`,
                    retryable: false,
                  },
                }),
              },
            ],
          };
        }
        try {
          const result = await tool.handler(ctx, input, { signal: extra.signal });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          const rhErr = toRhError(err);
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify({ error: rhErr.toJSON() }) }],
          };
        }
      },
    );
  }
  return server;
}

async function main(): Promise<void> {
  const ctx = createBridgeContext();
  const server = buildMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  ctx.logger.info("rh-agent-bridge MCP server started (stdio)", {
    toolCount: TOOL_REGISTRY.length,
  });
}

/* 入口：直接运行时启动；被 import（测试）时不执行 */
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
const isDirectRun =
  process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `fatal: rh-agent-bridge MCP server failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
