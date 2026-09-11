/**
 * rh_doctor（04 §2）：配置与 Native 能力体检。
 * 幂等。native 探测失败不致命（AT-202）。
 *
 * P0.1-07：语义修正——configured 表示 key 已配置（存在性检查）；
 * 不再伪称 authenticated。当前不做真实认证请求（无官方零成本 account-status
 * 端点确认），故固定返回 authenticationChecked: false，避免 Agent 误判
 * key 已通过服务端验证。
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
      ...(snapshot.probeDetails ? { details: snapshot.probeDetails } : {}),
      catalogCount: snapshot.count,
    };
  }
  return {
    ok: configCheck.ok,
    runningHub: {
      // P0.1-07：configured = key 已配置；authenticated 仅在真实服务端验证后才为 true
      configured: configCheck.ok,
      authenticationChecked: false,
      ...(configCheck.ok ? {} : { missing: configCheck.missing }),
    },
    nativeComfy,
  };
}
