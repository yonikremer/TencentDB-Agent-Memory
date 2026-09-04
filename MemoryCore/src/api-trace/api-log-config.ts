/**
 * API trace runtime config: level inferred from metadata store backend; defaults to writing stdout JSON.
 */
import type { MetadataBackend } from "../metadata/store/interface.js";
import { resolvePolicy, type ApiTracePolicy } from "./api-trace-policy.js";

export interface ApiTraceLogConfig {
  enabled: boolean;
}

export interface ApiTraceInitOptions {
  enabled?: boolean;
}

export interface ApiTraceRuntimeConfig {
  log: ApiTraceLogConfig;
  policy: ApiTracePolicy;
}

let runtimeConfig: ApiTraceRuntimeConfig | null = null;

function buildConfig(
  backend: MetadataBackend = "sqlite",
  opts?: ApiTraceInitOptions,
): ApiTraceRuntimeConfig {
  return {
    log: { enabled: opts?.enabled ?? true },
    policy: resolvePolicy(backend),
  };
}

/** Inject metadata storage backend upon Gateway startup (determines full/lite). */
export function initApiTraceConfig(
  metadataBackend: MetadataBackend = "sqlite",
  opts?: ApiTraceInitOptions,
): void {
  runtimeConfig = buildConfig(metadataBackend, opts);
}

export function getApiTraceConfig(): ApiTraceRuntimeConfig {
  if (!runtimeConfig) {
    runtimeConfig = buildConfig("sqlite");
  }
  return runtimeConfig;
}

/** For testing: reset cached config. */
export function resetApiTraceConfigForTests(): void {
  runtimeConfig = null;
}

export function isApiTraceActive(): boolean {
  return getApiTraceConfig().log.enabled;
}

export { resolvePolicy, resolveProfile, type ApiTracePolicy } from "./api-trace-policy.js";
