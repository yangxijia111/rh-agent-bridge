/**
 * Resource Upload API（03_RUNNINGHUB_API_REFERENCE.md §10）。
 *
 * POST /task/openapi/upload（multipart/form-data: apiKey / file / fileType）
 *
 * 硬性约束：
 *  - 返回的 fileName 是加载节点使用的相对路径，严禁拼接成公共访问 URL
 *  - 上传 POST 默认不自动重试（服务端可能已完成，重试会重复上传）
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { RhError, RhNetworkError } from "../../errors.js";
import type { RequestContext } from "./client.js";
import { uploadDataSchema } from "./schemas.js";

/** 官方当前文档：单文件上限 30MB */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

/** 官方文档列出的支持类型（扩展名小写） */
export const SUPPORTED_EXTENSIONS = new Set([
  "jpg",
  "png",
  "jpeg",
  "webp",
  "zip",
  "mp3",
  "wav",
  "flac",
  "mp4",
  "avi",
  "mov",
  "mkv",
]);

export interface UploadResult {
  /** 服务器相对路径（如 api/xxx.png）；只能作为加载节点的 fieldValue */
  fileName: string;
  fileType?: string;
}

export class UploadApi {
  constructor(
    private readonly ctx: RequestContext,
    /** 注入 Bearer 头（multipart 请求同样需要认证） */
    private readonly authHeaders: () => Record<string, string>,
  ) {}

  async uploadResource(filePath: string, fileType = "input"): Promise<UploadResult> {
    const info = await stat(filePath).catch(() => {
      throw new RhError("UPLOAD_FAILED", `file not found: ${filePath}`);
    });
    if (!info.isFile()) {
      throw new RhError("UPLOAD_FAILED", `not a regular file: ${filePath}`);
    }
    if (info.size > MAX_UPLOAD_BYTES) {
      throw new RhError("UPLOAD_FAILED", `file exceeds 30MB limit (${info.size} bytes)`);
    }
    const ext = basename(filePath).split(".").pop()?.toLowerCase() ?? "";
    if (ext && !SUPPORTED_EXTENSIONS.has(ext)) {
      throw new RhError(
        "UPLOAD_FAILED",
        `unsupported file extension "${ext}"; supported: ${[...SUPPORTED_EXTENSIONS].join("/")}`,
      );
    }

    const form = new FormData();
    form.append("apiKey", this.ctx.apiKey);
    form.append("fileType", fileType);
    // Node 20+ FormData 支持以 Blob 形式携带文件流
    const bytes = await readFileBytes(filePath);
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
      basename(filePath),
    );

    // multipart 边界由 undici 生成；不手动设置 Content-Type
    return this.ctx.request(
      { method: "POST", path: "/task/openapi/upload", formData: form, allowRetry: false },
      (raw) => {
        const parsed = uploadDataSchema.parse(raw ?? {});
        return { fileName: parsed.fileName, fileType: parsed.fileType ?? undefined };
      },
    );
  }
}

async function readFileBytes(filePath: string): Promise<Buffer> {
  try {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    throw new RhNetworkError(
      `failed to read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err,
    );
  }
}
