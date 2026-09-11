/**
 * Resource 工具（04 §10）：上传素材。
 * 非幂等（会产生服务端文件）。
 */
import { z } from "zod";
import type { BridgeContext } from "../services/context.js";

export const resourceUploadInputSchema = z.object({
  path: z.string().min(1),
  fileType: z.string().optional().default("input"),
});

export async function resourceUploadTool(
  ctx: BridgeContext,
  input: z.infer<typeof resourceUploadInputSchema>,
) {
  const result = await ctx.resource.upload(input.path, input.fileType);
  return {
    fileName: result.fileName,
    ...(result.fileType !== undefined ? { fileType: result.fileType } : {}),
    note: "fileName is a relative path for load nodes (e.g. LoadImage.image); never a public URL",
  };
}
