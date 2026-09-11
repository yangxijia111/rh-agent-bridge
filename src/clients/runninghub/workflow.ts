/**
 * Workflow API（03_RUNNINGHUB_API_REFERENCE.md §2）。
 *
 * POST /api/openapi/getJsonApiFormat
 * 注意：response.data.prompt 是 JSON 字符串，需要二次 JSON.parse。
 */
import { RhInvalidWorkflowError } from "../../errors.js";
import type { RequestContext } from "./client.js";
import { workflowApiFormatDataSchema } from "./schemas.js";

export class WorkflowApi {
  constructor(private readonly ctx: RequestContext) {}

  /** 获取 workflow 的 API Format 原始 JSON 对象（已二次 parse） */
  async getJsonApiFormat(workflowId: string): Promise<Record<string, unknown>> {
    const data = await this.ctx.request(
      {
        method: "POST",
        path: "/api/openapi/getJsonApiFormat",
        body: { apiKey: this.ctx.apiKey, workflowId },
        allowRetry: true,
      },
      (raw) => workflowApiFormatDataSchema.parse(raw ?? {}),
    );
    return parsePromptString(data.prompt);
  }
}

function parsePromptString(prompt: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    throw new RhInvalidWorkflowError("data.prompt is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RhInvalidWorkflowError("data.prompt is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}
