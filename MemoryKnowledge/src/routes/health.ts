/**
 * Health check route.
 *
 * dependencies.llm reports cheap local state only (no live inference on
 * scrapes): routing mode, whether global creds exist, live per-instance
 * binding count, and the last ingest failure observed. No traffic yet =
 * lastError null (honest unknown). Never exposes keys or URLs.
 */

import { Hono } from "hono";
import { lastLlmError } from "../dependency-health.js";

export interface HealthRouteDeps {
  /** Global LLM routing mode (proxy = per-instance bindings). */
  llmMode?: string;
  /** Whether global direct creds (baseUrl + apiKey) are present. */
  globalConfigured?: boolean;
  /** Live per-instance binding count. */
  bindingCount?: number;
}

export function createHealthRoutes(deps: HealthRouteDeps = {}): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      dependencies: {
        llm: {
          mode: deps.llmMode ?? "unknown",
          globalConfigured: deps.globalConfigured ?? false,
          bindings: deps.bindingCount ?? 0,
          lastError: lastLlmError(),
        },
      },
    });
  });

  return app;
}
