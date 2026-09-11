/**
 * rh_doctor（04 §2）：配置与 Native 能力体检。
 * 幂等。native 探测失败不致命（AT-202）。
 */
import { z } from "zod";
import { checkConfig } from "../config/env.js";
import type { BridgeContext } from "../services/context.js";

export const doctorInputSchema = z.object({
  probeNative: z.boolean().optional().default(true),
});

export async function doctorTool(ctx: BridgeContext, input: z.infer<typeof doctorInputSchema>) {
  const configCheck = checkConfig(ctx.config);
  let nativeComfy: Record<string, unknown> = { enabled: false, probed: false };
  if (input.probeNative && configCheck.ok) {
    const snapshot = await ctx.catalog.probe();
    nativeComfy = {
      enabled: snapshot.capabilities.objectInfo || snapshot.capabilities.features,
      probed: true,
      capabilities: snapshot.capabilities,
      catalogCount: snapshot.count,
    };
  }
  return {
    ok: configCheck.ok,
    runningHub: {
      // 存在性检查（不消耗 API 配额的真实调用）
      authenticated: configCheck.ok,
      ...(configCheck.ok ? {} : { missing: configCheck.missing }),
    },
    nativeComfy,
  };
}
