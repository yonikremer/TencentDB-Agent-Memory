/**
 * Dependency health recorder — last observed LLM errors for /health.
 *
 * /health must stay cheap, so no live inference happens there. Ingest
 * failures record here; /health surfaces configured state plus the last
 * observed error. No traffic yet = lastError null (honest unknown).
 */

export interface DependencyErrorRecord {
 message: string;
 at: string;
}

let llmLastError: DependencyErrorRecord | null = null;

/** Record an LLM failure observed on a request/worker path (secret-free message). */
export function recordLlmError(message: string): void {
 llmLastError = { message, at: new Date().toISOString() };
}

/** Last observed LLM error, or null when none seen yet. */
export function lastLlmError(): DependencyErrorRecord | null {
 return llmLastError;
}

/** Test-only reset (health assertions must not leak across suites). */
export function resetDependencyErrors(): void {
 llmLastError = null;
}
