/**
 * ComfyUI 原生路由响应 schemas（宽松校验；ComfyUI 各版本差异较大，此处只校验顶层形态）。
 */
import { z } from "zod";

/** GET /object_info → { [classType]: NodeDefRaw } */
export const objectInfoSchema = z.record(
  z.string(),
  z
    .object({
      input: z
        .object({
          required: z.record(z.array(z.unknown())).optional(),
          optional: z.record(z.array(z.unknown())).optional(),
        })
        .optional(),
      output: z.array(z.string()).optional(),
      output_name: z.array(z.string()).optional(),
      name: z.string().optional(),
      display_name: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      output_node: z.boolean().optional(),
    })
    .passthrough(),
);
export type ObjectInfoRaw = z.infer<typeof objectInfoSchema>;

/** GET /models → { [folder]: string[] } */
export const modelsSchema = z.record(z.string(), z.array(z.string()));
export type ModelsRaw = z.infer<typeof modelsSchema>;

/** GET /features → 任意 JSON 对象 */
export const featuresSchema = z.record(z.string(), z.unknown());
