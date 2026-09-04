/**
 * Prewarm runner — invoked once at session_init Case 2 (immediately after
 * the control plane registers the session and the SessionStore has its
 * `initialized` state). For every hook declaring
 * `cacheStrategy ∈ {"session_init", "hybrid"}`, this runs `hook.prewarm(input)`
 * in parallel and persists the resulting blocks into `HookCacheRepo`.
 *
 * Semantics:
 *   - Best-effort. Single-hook failure → warn-log + skip (no cache for that hook).
 *   - Total timeout (default 8s). Hooks not finished by then → warn-log + skip.
 *   - The whole call NEVER throws (silently degrades to no caching).
 *
 * The repo write is the side-effect; this function returns the list of
 * successfully cached hookIds for diagnostics/tests.
 */

import type { HookCacheRepo } from "../db/hookCacheRepo.js";
import type {
  ContextBlock,
  HookRegistry,
  InjectionHook,
  PrewarmInput,
} from "./types.js";

export interface PrewarmOptions {
  /** Total timeout for the whole prewarm pass, in ms. Defaults to 20000. */
  totalTimeoutMs?: number;
  /**
   * For scene refresh only: explicitly `clearBySession` to wipe all existing caches for the session before prewarm,
   * making the result of this prewarm the **single source of truth**. Default is `false` (retains the first session_init
   * semantics: on cache miss, the pipeline executes `execute()` and self-heals).
   *
   * Why this switch is needed: initial session_init and mem:sync refresh share the same entrypoint
   * `prewarmFromConfig`, but have different semantics:
   *   - Initial: The cache is naturally empty. If prewarm gets `[]`/error, it skips writing, and when the pipeline
   *     gets a null, it will `execute()` on the fly and self-heal the cache — semantic loop closed.
   *   - Refresh: The cache **already contains old data**. If prewarm gets `[]` for a hook (e.g., user
   *     just unbound wiki+codegraph) or encounters a timeout/exception, `prewarmAll` will skip writing, leaving the
   *     old data untouched on COS; the next pipeline request will read the old snapshot from COS and continue injecting it,
   *     resulting in "assets are unbound but injection still carries them".
   *
   * With `clearBefore` enabled, the semantics become "prewarm gets what it gets, if it doesn't get it, it doesn't exist":
   *   - Hook A has content → overwrites cache (normal).
   *   - Hook B gets `[]` → old cache is cleared by the clear above, no longer hits (fixes the knowledge bug).
   *   - Hook C prewarm throws exception/timeout → old cache is also cleared, next pipeline will `execute()`
   *     as fallback — a single network jitter won't let the old snapshot "live forever".
   */
  clearBefore?: boolean;
}

export interface PrewarmResult {
  cachedHookIds: string[];
  skipped: Array<{ hookId: string; reason: string }>;
  durationMs: number;
}

// 8s → 20s (2026-07-11): tdai-profile-memory-injector prewarm needs to read
// self + L2 index + L3 persona for the agent corresponding to each imported chat_memory
// (via COS); when imported agents exist or COS is slow, 8s often times out causing
// the entire <tdai_profile_memory> paragraph to be lost. Relaxed to 20s to cover typical dev machine scenarios.
const DEFAULT_TOTAL_TIMEOUT_MS = 20000;

function shouldPrewarm(hook: InjectionHook): boolean {
  const s = hook.cacheStrategy ?? "none";
  return s === "session_init" || s === "hybrid";
}

/** Run a promise with a per-task timeout. Rejects on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`prewarm timeout(${ms}ms): ${label}`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Prewarm all eligible hooks for a freshly initialized session.
 *
 * @param registry  The injection HookRegistry (typically the global one).
 * @param repo      Where to persist the prewarmed blocks.
 * @param input     PrewarmInput (sessionInfo, agentDetail, taskDetail, keyId).
 * @param opts      Optional knobs (timeout, etc.).
 */
export async function prewarmAll(
  registry: HookRegistry,
  repo: HookCacheRepo,
  input: PrewarmInput,
  opts: PrewarmOptions = {},
): Promise<PrewarmResult> {
  const startedAt = Date.now();
  const sessionId = input.sessionInfo.session_id;
  const totalBudget = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const cachedHookIds: string[] = [];
  const skipped: Array<{ hookId: string; reason: string }> = [];

  const all = registry.getAll();
  const targets = all.filter(shouldPrewarm);

  if (targets.length === 0) {
    console.log(
      `[hook-cache] prewarm session=${sessionId}: no hooks declared cacheStrategy, skipping`,
    );
    return { cachedHookIds, skipped, durationMs: Date.now() - startedAt };
  }

  // Refresh scenario: First clear all existing caches for all hooks in this session, making this prewarm
  // the single source of truth. See the comments for `PrewarmOptions.clearBefore` for a detailed explanation of why
  // the first session_init does not need this, but refresh MUST do this.
  //
  // Deliberately placed after checking targets is non-empty → before each hook executes: if the registry has absolutely no
  // hooks that need prewarm, clearing is meaningless (and might mistakenly clear things written by others in the same session).
  //
  // clearBySession swallows underlying errors internally (see hookCacheRepo implementations), and will not
  // block subsequent prewarms, fitting the overall semantics of "prewarm is best-effort".
  if (opts.clearBefore) {
    try {
      await repo.clearBySession(input.spaceId ?? "", input.userId, input.agentSource, sessionId);
      console.log(
        `[hook-cache] prewarm session=${sessionId}: clearBefore=true, cleared existing entries`,
      );
    } catch (err) {
      console.warn(
        `[hook-cache] prewarm session=${sessionId}: clearBefore failed (continuing):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Per-hook budget: shared total, but each individual call also caps at
  // `totalBudget` so a single hang can't starve siblings (Promise.allSettled
  // ensures we observe all settlements regardless).
  const runs = targets.map(async (hook) => {
    try {
      if (typeof hook.prewarm !== "function") {
        return { hookId: hook.id, status: "skipped" as const, reason: "no prewarm() implemented" };
      }
      const blocks = await withTimeout(
        Promise.resolve(hook.prewarm(input)),
        totalBudget,
        `hook=${hook.id}`,
      );
      const arr: ContextBlock[] = Array.isArray(blocks) ? blocks : [];
      if (arr.length === 0) {
        return { hookId: hook.id, status: "skipped" as const, reason: "empty blocks" };
      }
      return { hookId: hook.id, status: "ok" as const, blocks: arr };
    } catch (err) {
      return {
        hookId: hook.id,
        status: "error" as const,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Top-level total deadline: even if one hook hangs longer than per-hook,
  // we don't want session_init to block forever.
  const settled = await Promise.race([
    Promise.allSettled(runs),
    new Promise<PromiseSettledResult<unknown>[]>((resolve) => {
      setTimeout(() => resolve([]), totalBudget + 500);
    }),
  ]);

  if (settled.length === 0) {
    console.warn(
      `[hook-cache] prewarm session=${sessionId}: global timeout ${totalBudget}ms exceeded`,
    );
    return { cachedHookIds, skipped, durationMs: Date.now() - startedAt };
  }

  const okEntries: Array<{ hookId: string; blocks: ContextBlock[] }> = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") {
      // allSettled wrapped each task's catch already; this branch is unreachable
      // in practice, but kept for safety.
      skipped.push({ hookId: "<unknown>", reason: String((s as PromiseRejectedResult).reason) });
      continue;
    }
    const r = s.value as
      | { hookId: string; status: "ok"; blocks: ContextBlock[] }
      | { hookId: string; status: "skipped"; reason: string }
      | { hookId: string; status: "error"; reason: string };
    if (r.status === "ok") {
      okEntries.push({ hookId: r.hookId, blocks: r.blocks });
      cachedHookIds.push(r.hookId);
    } else {
      skipped.push({ hookId: r.hookId, reason: r.reason });
    }
  }

  if (okEntries.length > 0) {
    await repo.putMany(input.spaceId ?? "", input.userId, input.agentSource, sessionId, okEntries);
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[hook-cache] prewarm session=${sessionId}: cached=${cachedHookIds.length} skipped=${skipped.length} durationMs=${durationMs}`,
  );
  if (skipped.length > 0) {
    for (const s of skipped) {
      console.log(`[hook-cache]   - skip hook=${s.hookId} reason=${s.reason}`);
    }
  }

  return { cachedHookIds, skipped, durationMs };
}
