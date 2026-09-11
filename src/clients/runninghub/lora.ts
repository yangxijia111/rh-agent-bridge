/**
 * LoRA Upload API（03_RUNNINGHUB_API_REFERENCE.md §11）。
 *
 * POST /api/openapi/getLoraUploadUrl
 * 第一步：换取 fileName + 一次性 signed upload URL；
 * 第二步（由调用方执行）：把文件 PUT/POST 到 signed URL；
 * 之后在 RHLoraLoader 中使用返回的 fileName。
 *
 * signed URL 绝不能写入长期日志（redaction 已覆盖）。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RequestContext } from "./client.js";
import { loraUploadDataSchema } from "./schemas.js";

export interface LoraUploadRequest {
  loraName: string;
  /** 本地文件路径（用于计算 md5） */
  filePath: string;
}

export interface LoraUploadPreparation {
  /** 用于 RHLoraLoader.lora_name 的相对路径 */
  fileName: string;
  /** 一次性 signed upload URL；上传完成后即失效，不落日志 */
  uploadUrl: string;
  /** 文件 md5（hex） */
  md5Hex: string;
}

export class LoraApi {
  constructor(private readonly ctx: RequestContext) {}

  async getLoraUploadUrl(input: LoraUploadRequest): Promise<LoraUploadPreparation> {
    const bytes = await readFile(input.filePath);
    // MD5 为 RunningHub 官方协议字段（服务端文件去重标识，非安全哈希用途），不可替换
    const md5Hex = createHash("md5").update(bytes).digest("hex");
    const data = await this.ctx.request(
      {
        method: "POST",
        path: "/api/openapi/getLoraUploadUrl",
        body: { apiKey: this.ctx.apiKey, loraName: input.loraName, md5Hex },
        allowRetry: true,
      },
      (raw) => loraUploadDataSchema.parse(raw ?? {}),
    );
    return { fileName: data.fileName, uploadUrl: data.url, md5Hex };
  }
}
