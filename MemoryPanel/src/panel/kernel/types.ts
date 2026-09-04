import type { MetaEnvelope } from './envelope.js';

export interface KernelCredentials {
  endpoint: string;
  apiKey: string;
  instanceId: string;
  userKey?: string;
  timeoutMs: number;
  requestId?: string;
}

/** Runtime credentials for a single kernel metadata call (middleware assembled from Header + registry). */
export interface MetaCallContext {
  instanceId: string;
  gatewayEndpoint: string;
  gatewayApiKey: string;
  userKey?: string;
  reqId?: string;
}

export type { MetaEnvelope };

export function toKernelCredentials(
  ctx: MetaCallContext,
  config: { timeoutMs: number },
  opts?: { omitUserKey?: boolean },
): KernelCredentials {
  return {
    endpoint: ctx.gatewayEndpoint,
    apiKey: ctx.gatewayApiKey,
    instanceId: ctx.instanceId,
    userKey: opts?.omitUserKey ? undefined : ctx.userKey,
    timeoutMs: config.timeoutMs,
    requestId: ctx.reqId,
  };
}
