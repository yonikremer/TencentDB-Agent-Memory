/**
 * Dependency health recorder — last observed model errors for /health.
 *
 * Health endpoints must stay cheap (k8s scrapes every few seconds), so no
 * live inference happens there. Instead, the fail-loud data-plane paths
 * record real failures here; /health surfaces configured/ready state plus
 * the last observed error with timestamp. No traffic yet = lastError null
 * (honest "unknown", not fake "ok").
 */

export interface DependencyErrorRecord {
 message: string;
 at: string;
}

export type DependencyKind = "embedding" | "llm";

const lastErrors: Record<DependencyKind, DependencyErrorRecord | null> = {
 embedding: null,
 llm: null,
};

/** Record a model failure observed on a request path (message must be secret-free). */
export function recordDependencyError(
 kind: DependencyKind,
 message: string,
): void {
 lastErrors[kind] = { message, at: new Date().toISOString() };
}

/** Last observed error for a dependency, or null when none seen yet. */
export function lastDependencyError(
 kind: DependencyKind,
): DependencyErrorRecord | null {
 return lastErrors[kind];
}

export interface EmbeddingDependencyState {
 configured: boolean;
 ready: boolean;
 lastError: DependencyErrorRecord | null;
}

/** Pure mapping for /health: presence + guarded readiness + last error. */
export function embeddingDependency(
 svc: { isReady(): boolean } | null | undefined,
): EmbeddingDependencyState {
 if (!svc)
  return {
   configured: false,
   ready: false,
   lastError: lastDependencyError("embedding"),
  };
 let ready = false;
 try {
  ready = svc.isReady();
 } catch {
  ready = false;
 }
 return {
  configured: true,
  ready,
  lastError: lastDependencyError("embedding"),
 };
}

/** Test-only reset (health assertions must not leak across suites). */
export function resetDependencyErrors(): void {
 lastErrors.embedding = null;
 lastErrors.llm = null;
}
