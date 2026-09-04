/**
 * Credit pricing lookup for LLM usage → cost calculation.
 *
 * TDAI-issued billing rules are quoted in Credit / 1K Token units, priced separately
 * by token type (input / output / cacheRead / cacheWrite5m / cacheWrite1h).
 * The pricing table lives in `creditPricing.models` in config.yaml and supports hot reload.
 *
 * Matching rule (`getModelPricing`):
 *   Case-insensitive full-word match — after ignoring case, modelId and config.name
 *   must be exactly equal.
 *   When there is no match, returns null and the caller falls back to raw token count.
 */

import type { CreditPricingConfig, CreditPricingEntry } from "./types.js";

/**
 * Look up model pricing by case-insensitive full-word match.
 *
 * @param config - Credit pricing configuration (from config.yaml).
 * @param modelId - Model identifier (usually the `model` field from usage).
 * @returns Matched pricing entry, or `null` if no match.
 */
export function getModelPricing(
  config: CreditPricingConfig | null | undefined,
  modelId: string | null | undefined,
): CreditPricingEntry | null {
  if (!config?.models?.length || !modelId) return null;

  const lower = modelId.toLowerCase();
  return config.models.find((m) => m.name.toLowerCase() === lower) ?? null;
}

/**
 * Resolve a model's display name (for UI/reporting).
 *
 * Matching logic:
 * 1. `modelId` is empty/null/undefined → returns `""`
 * 2. Pricing table hit and entry.modelName is non-empty → returns entry.modelName (e.g. "Claude Sonnet 4")
 * 3. Pricing table miss, or hit but modelName is not configured/empty → **falls back to modelId itself**
 *    (the frontend always has a non-empty display; an unknown model can at least see its internal ID)
 *
 * Shares the same matching logic as `getModelPricing` (case-insensitive full-word match).
 *
 * @param config - Credit pricing configuration.
 * @param modelId - Model identifier from usage.
 * @returns The display-name string (never null, may be "").
 */
export function resolveModelName(
  config: CreditPricingConfig | null | undefined,
  modelId: string | null | undefined,
): string {
  if (!modelId) return "";
  const entry = getModelPricing(config, modelId);
  return entry?.modelName || modelId;
}

/**
 * Reverse resolution: map a client-side display name (`modelName`) back to the real `model_id` (`entry.name`).
 *
 * Used at the request interception stage — a client may put a recognizable `modelName`
 * (e.g. `claude-opus-4.7`) in the `model` field; before forwarding upstream the proxy
 * swaps it for the corresponding model_id (e.g. `ep-pksklwtb`). This is the inverse of
 * `resolveModelName`, reusing the same `creditPricing.models` mapping to avoid dual maintenance.
 *
 * Matching logic (case-insensitive, consistent with `getModelPricing`):
 * 1. `requested` is empty/null/undefined → return as-is (empty string)
 * 2. Matches some entry's `modelName` (case-insensitive, non-empty) → return that entry's `name`
 * 3. No match (including requested already being a real model_id, or an unknown model) → **return as-is**
 *    (for backward compatibility: clients passing a real model_id directly are unaffected)
 *
 * If the same `modelName` maps to multiple entries, the first match is used (`Array.find` semantics).
 *
 * @param config - Credit pricing configuration.
 * @param requested - The `model` field value from the client request.
 * @returns The real model_id; falls back to `requested` itself when there is no match.
 */
export function resolveModelId(
  config: CreditPricingConfig | null | undefined,
  requested: string | null | undefined,
): string {
  if (!requested) return requested ?? "";
  if (!config?.models?.length) return requested;

  const lower = requested.toLowerCase();
  const entry = config.models.find(
    (m) => !!m.modelName && m.modelName.toLowerCase() === lower,
  );
  return entry?.name || requested;
}

/**
 * Check whether a client-requested `model` is registered under the pricing table's
 * **`modelName` (display name)**.
 *
 * Used as a gate at the request entry: when a pricing table is configured, clients may only
 * request by display name (`modelName`); the real `model_id` (`entry.name`) is treated as an
 * internal detail and is no longer a public entry point. Any unmatched model is rejected, to
 * avoid the silent un-billed problem of "forwarded successfully but cannot be billed".
 *
 * Rules:
 * 1. `config` / `config.models` is empty → **returns true** (skip the check when no pricing
 *    table is configured; backward compatible with old deployments; handled by the raw
 *    reconciliation path in `computeCreditDelta`).
 * 2. `requested` is empty/null/undefined → **returns false** (a model must be explicitly provided to allow it through).
 * 3. Matches any entry's **non-empty** `modelName` (case-insensitive full-word match) → true.
 * 4. Otherwise → false.
 *
 * Note: an entry without `modelName` configured cannot be hit by a client request (such a model
 * is "internal-only", used solely for internal forwarding and not exposed to clients).
 *
 * @param config - Credit pricing configuration.
 * @param requested - The `model` field value from the client request.
 * @returns Whether the request is allowed through.
 */
export function isModelInPricing(
  config: CreditPricingConfig | null | undefined,
  requested: string | null | undefined,
): boolean {
  // No pricing table configured: skip the check (backward compatible)
  if (!config?.models?.length) return true;
  // A non-empty model is required explicitly
  if (!requested) return false;

  const lower = requested.toLowerCase();
  return config.models.some(
    (m) => !!m.modelName && m.modelName.toLowerCase() === lower,
  );
}
