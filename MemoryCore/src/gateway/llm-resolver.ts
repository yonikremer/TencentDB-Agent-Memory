/**
 * LLM provider resolver —— combines the llm section in yaml and memory systemUser into
 * a {baseUrl, apiKey, model, ...} config directly usable by the core runner.
 *
 * Two modes:
 *   1. provider="openai" (default): returns llm config as-is, backward compatible
 *   2. provider="proxy": concatenates baseUrl into `${baseUrl}/proxy/<instanceId>/v1`,
 *      apiKey uses metadata.systemUser.memory.userKey (memory system role sk-mem-xxx).
 *      This way all LLM calls from core will carry the memory identity, going through context_proxy's unified auth,
 *      cost guard, and observability tracing.
 *
 * Single Responsibility: this file only does "calculate final baseUrl / apiKey", it does not create runners; four entry points
 * (tdai-core.ts:636/987/1037/1082, server.ts buildOffloadLlmClient) call this function uniformly before
 * constructing runners.
 */

import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";
import type { GatewayMetadataConfig } from "./config.js";
import {
  isValidMemorySystemUserKey,
  resolveMemorySystemUserConfig,
  type MemorySystemUserConfig,
} from "../metadata/system-user.js";

export class LlmResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmResolveError";
  }
}

/**
 * Calculate the final (baseUrl, apiKey, model, ...) for core LLM calls under a given instanceId.
 *
 * @param llm            llm section from gateway yaml (including provider)
 * @param instanceId     id of the instance currently being processed (used to build path when provider=proxy)
 * @param memorySystemUser resolved memory system user config (optional, used only when provider=proxy and
 *                         useMemorySystemUserKey=true)
 *
 * @throws {LlmResolveError} when provider=proxy but required configs are missing
 */
export function resolveEffectiveLlmConfig(
  llm: StandaloneLLMConfig,
  instanceId: string | undefined,
  memorySystemUser: MemorySystemUserConfig | undefined,
): StandaloneLLMConfig {
  const provider = llm.provider ?? "openai";
  if (provider !== "proxy") {
    // Default path: return as-is, behavior is exactly equivalent to before refactor
    return llm;
  }

  // provider=proxy validations
  if (!llm.baseUrl) {
    throw new LlmResolveError(
      "llm.provider=proxy requires llm.baseUrl pointing to context_proxy root URL (e.g. http://127.0.0.1:8096)",
    );
  }
  if (!instanceId || !instanceId.trim()) {
    throw new LlmResolveError(
      "llm.provider=proxy requires instanceId, but core's current instanceId is empty —— " +
      "ensure requests include x-tdai-service-id in service mode, or instanceId exists in yaml for standalone mode",
    );
  }

  const useSystemUserKey = llm.proxy?.useMemorySystemUserKey ?? true;
  let effectiveApiKey = llm.apiKey;
  if (useSystemUserKey) {
    if (!memorySystemUser) {
      throw new LlmResolveError(
        "llm.provider=proxy and llm.proxy.useMemorySystemUserKey=true require " +
        "complete metadata.systemUser.memory config (userId + userKey), currently missing",
      );
    }
    if (!isValidMemorySystemUserKey(memorySystemUser.userKey)) {
      throw new LlmResolveError(
        "metadata.systemUser.memory.userKey must match sk-mem-[A-Za-z0-9_-]{32}",
      );
    }
    effectiveApiKey = memorySystemUser.userKey;
  }

  if (!effectiveApiKey) {
    throw new LlmResolveError(
      "llm.apiKey must be explicitly configured when llm.provider=proxy and useMemorySystemUserKey=false",
    );
  }

  // baseUrl concatenation rule: strip trailing slashes, append /proxy/<iid>/v1
  const cleanBase = llm.baseUrl.replace(/\/+$/, "");
  const proxyBaseUrl = `${cleanBase}/proxy/${encodeURIComponent(instanceId)}/v1`;

  return {
    ...llm,
    baseUrl: proxyBaseUrl,
    apiKey: effectiveApiKey,
  };
}

/**
 * Validation only, does not return config —— used for startup "fail-fast" checks.
 * In standalone mode, instanceId is usually "default", can be validated directly;
 * In service mode, instanceId is only known per request, so startup only checks if systemUser is valid.
 */
export function validateLlmProviderConfig(
  llm: StandaloneLLMConfig,
  metadata: GatewayMetadataConfig,
): void {
  if (llm.provider !== "proxy") return;

  if (!llm.baseUrl) {
    throw new LlmResolveError(
      "llm.provider=proxy requires llm.baseUrl pointing to context_proxy root URL",
    );
  }

  const useSystemUserKey = llm.proxy?.useMemorySystemUserKey ?? true;
  if (useSystemUserKey) {
    const memoryUser = resolveMemorySystemUserConfig(metadata);
    if (!memoryUser) {
      throw new LlmResolveError(
        "llm.provider=proxy and useMemorySystemUserKey=true require " +
        "complete metadata.systemUser.memory config (userId + userKey)",
      );
    }
    if (!isValidMemorySystemUserKey(memoryUser.userKey)) {
      throw new LlmResolveError(
        "metadata.systemUser.memory.userKey must match sk-mem-[A-Za-z0-9_-]{32}",
      );
    }
  } else if (!llm.apiKey) {
    throw new LlmResolveError(
      "llm.apiKey must be explicitly configured when llm.provider=proxy and useMemorySystemUserKey=false",
    );
  }
}
