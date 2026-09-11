/**
 * Shared live-LLM test config. Single source for key/endpoint/model.
 *
 * Key: OPENROUTER_API_KEY via shell env or gitignored <repo>/tests/.env
 * (NEVER commit that file). Without a key — or without LLM_LIVE=1 — suites
 * skip. LLM_TEST_BASE_URL / LLM_TEST_MODEL override endpoint + model.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface LiveLlmConfig {
  key: string;
  baseUrl: string;
  model: string;
  /** True only with key + explicit opt-in (live runs cost money/rate limits). */
  live: boolean;
}

function readEnvFile() {
  const out = new Map<string, string>();
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const p = join(here, "..", ".env");
    if (!existsSync(p)) return out;
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/);
      const v = (m?.[2] ?? "").replace(/^["']|["']$/g, "");
      if (m && v) out.set(m[1], v);
    }
  } catch {
    /* missing file = env only */
  }
  return out;
}

// tests/.env is the explicit local config; shell env is the CI path.
const fileEnv = readEnvFile();
const pick = (name: string): string =>
  (fileEnv.get(name) ?? process.env[name] ?? "").trim();

export function loadLiveLlmConfig(): LiveLlmConfig {
  const key = pick("OPENROUTER_API_KEY");
  return {
    key,
    baseUrl: pick("LLM_TEST_BASE_URL") || "https://openrouter.ai/api/v1",
    model: pick("LLM_TEST_MODEL") || "nvidia/nemotron-3.5-lightning:free",
    live: key.length > 0 && (fileEnv.LLM_LIVE ?? process.env.LLM_LIVE ?? "") === "1",
  };
}
