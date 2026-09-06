/**
 * llm.ts — OpenAI-compatible chat invocation wrapper (wiki ingest dedicated).
 *
 * Reuses the repository's existing Vercel AI SDK (`ai` + `@ai-sdk/openai`) and calls standard
 * `/chat/completions`. The client is created with `baseURL` (plus apiKey) only; in @ai-sdk/openai
 * 3.x a custom baseURL uses the OpenAI-compatible chat-completions model by default, so no
 * explicit `compatibility` flag is needed (that option no longer exists in the installed SDK).
 *
 * The actual shape of llmConfig is passed from upper module.ts, with field names:
 *   { provider, apiKey, model, customEndpoint, maxContextSize }
 * Normalization is performed here to support aliases written in INTERFACE docs like { baseUrl, maxTokens, timeoutMs }.
 */

import { generateText, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createLogger } from "../../../logger.js";

const log = createLogger("wiki-ingest-llm");

/** Raw llmConfig passed in from upper layer (loose, fields may use different naming). */
export interface RawLlmConfig {
  protocol?: "openai" | "anthropic";
  provider?: string;
  apiKey?: string;
  model?: string;
  // Actual field names (module.ts)
  customEndpoint?: string;
  maxContextSize?: number;
  // INTERFACE documentation aliases
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Whether to use streaming requests (streamText) to call upstream. Default is false (non-streaming).
   * Certain compatible upstreams that only accept streaming requests must be set to true. Applies to both openai/anthropic protocols.
   *
   * ⚠️ Only takes effect on the direct wiki-ingest AI SDK path; does not affect MemoryCore/OpenClaw host
   * runner. Will not forward incremental tokens to callers, acting only as a compatibility layer that
   * "requests upstream via streaming protocol and waits for complete text".
   */
  stream?: boolean;
}

/** Normalized configuration. */
export interface NormalizedLlmConfig {
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  stream: boolean;
}

const DEFAULT_MODEL = "Memory-Model";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 1_200_000; // 20min — reasoning models require longer time

/**
 * Normalizes upper-layer config with diverse field names.
 *
 * Note: No longer falls back to reading process.env (historically reading TDAI_LLM_*, which bypassed resolveLlmConfig's
 * binding/mode logic and caused silent fallback to direct connection). baseUrl/apiKey must be provided by upper layer
 * (module.ts -> resolveLlmConfig); missing values cause createLlmClient to throw directly.
 */
export function normalizeLlmConfig(raw: RawLlmConfig | undefined): NormalizedLlmConfig {
  const cfg = raw ?? {};
  const protocol = cfg.protocol ?? "openai";
  const baseUrl = cfg.baseUrl || cfg.customEndpoint || "";
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || DEFAULT_MODEL;
  const maxTokens = cfg.maxTokens ?? cfg.maxContextSize ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stream = cfg.stream ?? false;
  return { protocol, baseUrl, apiKey, model, maxTokens, timeoutMs, stream };
}

export interface ChatParams {
  system: string;
  prompt: string;
  /** Overrides default max output tokens. */
  maxOutputTokens?: number;
  /** Sampling temperature (optional, uses SDK default if omitted). */
  temperature?: number;
  /** External abort signal (merged with internal timeout). */
  abortSignal?: AbortSignal;
  /** Invocation label (e.g. "analysis"/"generate"/"merge") for distinguishing steps in logs. */
  label?: string;
}

/** Abstract minimal LLM client interface for easy mocking during testing. */
export interface LlmClient {
  chat(params: ChatParams): Promise<string>;
  readonly config: NormalizedLlmConfig;
}

export function createLlmClient(config: NormalizedLlmConfig): LlmClient {
  const provider =
    config.protocol === "anthropic"
      ? createAnthropic({ apiKey: config.apiKey })
      : createOpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
        });

  return {
    config,
    async chat(params: ChatParams): Promise<string> {
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      const signal = params.abortSignal
        ? AbortSignal.any([timeoutSignal, params.abortSignal])
        : timeoutSignal;

      const label = params.label ?? "chat";
      const promptChars = params.system.length + params.prompt.length;
      const startMs = Date.now();
      log.info(`LLM call started [${label}]`, {
        model: config.model,
        protocol: config.protocol,
        promptChars,
        maxOutputTokens: params.maxOutputTokens ?? config.maxTokens,
        timeoutMs: config.timeoutMs,
      });
      log.debug(`LLM system prompt [${label}] (model=${config.model})`, { text: params.system.slice(0, 200) });
      log.debug(`LLM user prompt [${label}] (model=${config.model})`, { text: params.prompt.slice(0, 500) });

      try {
        const callParams = {
          model: provider.chat(config.model),
          system: params.system,
          prompt: params.prompt,
          maxOutputTokens: params.maxOutputTokens ?? config.maxTokens,
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          abortSignal: signal,
          experimental_telemetry: {
            isEnabled: true,
            functionId: params.label ?? "chat",
          },
        };

        // stream=true -> streamText (for upstreams that only accept streaming); otherwise generateText.
        // text/usage/finishReason in streamText are Promises, matching generateText shape after awaiting.
        const { text, usage, finishReason } = config.stream
          ? await (async () => {
              const r = streamText(callParams);
              return {
                text: ((await r.text) ?? "").trim(),
                usage: await r.usage,
                finishReason: await r.finishReason,
              };
            })()
          : await (async () => {
              const r = await generateText(callParams);
              return {
                text: (r.text ?? "").trim(),
                usage: r.usage,
                finishReason: r.finishReason,
              };
            })();

        const u = usage ?? ({} as Record<string, number>);
        log.info(`LLM call complete [${label}]`, {
          ms: Date.now() - startMs,
          promptTokens: u.inputTokens ?? null,
          completionTokens: u.outputTokens ?? null,
          totalTokens: u.totalTokens ?? null,
          finishReason: finishReason ?? null,
          outputChars: text.length,
        });
        if (!text) {
          log.warn(`LLM returned empty text [${label}]`, { finishReason: finishReason ?? null });
        }
        return text;
      } catch (err) {
        log.error(`LLM call failed [${label}]`, {
          ms: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}
