/**
 * Credit report policy —— determines the CreditDelta value reported to UpdateMemoryPlusUsage
 * when core L1/L2/L3 extraction is completed.
 *
 * Background: when llm.provider="proxy", context_proxy has already reported a CreditDelta = total_tokens
 * to the same UpdateMemoryPlusUsage after the LLM response is completed (see
 * context_proxy/src/credit-reporter.ts). If the core reports the tokens for the same call again,
 * it will result in double billing.
 *
 * Policy:
 *   - provider="openai": return as-is —— core is the sole credit reporter
 *   - provider="proxy": return 0 —— proxy has already reported, core skips
 *
 * memoryDelta is unrelated to this policy: memory is a core-exclusive semantic (how many memories written),
 * proxy is completely unaware, the core must be responsible for reporting it.
 */

export type LlmProvider = "openai" | "proxy";

export function shouldSkipCreditReport(provider: LlmProvider | undefined): boolean {
  return (provider ?? "openai") === "proxy";
}

/**
 * Calculate the actual CreditDelta that should be reported.
 *
 * @param rawCreditUsed  The accumulated token count in core llmRunner.accumulatedCredit
 * @param provider       llm.provider
 * @returns The CreditDelta to report (always 0 when provider=proxy)
 */
export function resolveReportedCredit(
  rawCreditUsed: number,
  provider: LlmProvider | undefined,
): number {
  return shouldSkipCreditReport(provider) ? 0 : rawCreditUsed;
}
