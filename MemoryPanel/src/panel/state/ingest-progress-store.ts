/**
 * Wiki ingest fine-grained progress (process memory).
 * KS → status-callback(event=ingest_progress) writes;
 * wiki/get aggregates reads; clear on terminal states ready/failed.
 *
 * B-2: with run_id generation + TTL, to avoid late writes of "final clear" indexing/98,
 * causing the next round's extracting/0 to be discarded by monotonic rules and the progress bar to get stuck at 98%.
 *
 * cleared keeps the set of recently cleared runIds per wiki (not just the last one),
 * to prevent: clear(run-1) → write run-2 → the late run-1 being mistakenly judged as a "new generation" and overwritten.
 */

export interface IngestProgress {
  phase: 'extracting' | 'merging' | 'indexing';
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  percent: number;
}

const PHASE_ORDER = { extracting: 0, merging: 1, indexing: 2 } as const;

/** Default 30min; stuck processing residuals do not permanently occupy slots. */
export const DEFAULT_INGEST_PROGRESS_TTL_MS = 30 * 60 * 1000;

interface StoreEntry {
  runId: string | null;
  progress: IngestProgress;
  updatedAt: number;
}

export interface IngestProgressStoreOptions {
  ttlMs?: number;
  /** Injectable clock for TTL unit testing */
  now?: () => number;
}

export class IngestProgressStore {
  private readonly store = new Map<string, StoreEntry>();
  /** wikiId → (runId → clearedAt); reject these intergenerational late progress */
  private readonly cleared = new Map<string, Map<string, number>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts?: IngestProgressStoreOptions) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_INGEST_PROGRESS_TTL_MS;
    this.now = opts?.now ?? Date.now;
  }

  /**
   * Monotonic update: higher phase wins;
   * When phases are the same, higher percent wins;
   * If percent is the same (rounding collision), higher completed+failed wins to avoid counting stagnation.
   *
   * runId：
   * - Falls into an already clear set → discard (including late packets across generations);
   * - Same as the current entry (or both are empty) → apply the monotonic rule;
   * - Different from the current entry and non-empty → treated as a new ingest round, directly overwrite.
   */
  update(wikiId: string, incoming: IngestProgress, runId?: string | null): void {
    const rid = normalizeRunId(runId);
    this.pruneCleared(wikiId);

    const clearedRuns = this.cleared.get(wikiId);
    if (clearedRuns && clearedRuns.size > 0) {
      if (rid && clearedRuns.has(rid)) return; // Late packets for cleared generations
      if (!rid) {
        // This wiki has just been cleared: late packages without runId are also discarded, to avoid writing back 98% after clear
        return;
      }
    }

    const prev = this.store.get(wikiId);
    const ts = this.now();
    if (!prev || this.isExpired(prev)) {
      this.store.set(wikiId, { runId: rid, progress: incoming, updatedAt: ts });
      return;
    }

    // New runId → allows restarting from extracting/0 (and that rid is not in the cleared set)
    if (rid && prev.runId && rid !== prev.runId) {
      this.store.set(wikiId, { runId: rid, progress: incoming, updatedAt: ts });
      return;
    }
    // No runId currently, but the package has a runId: treated as a new generation override (upgrade path)
    if (rid && !prev.runId) {
      this.store.set(wikiId, { runId: rid, progress: incoming, updatedAt: ts });
      return;
    }

    const prevOrder = PHASE_ORDER[prev.progress.phase];
    const inOrder = PHASE_ORDER[incoming.phase];
    if (inOrder > prevOrder) {
      this.store.set(wikiId, { runId: prev.runId ?? rid, progress: incoming, updatedAt: ts });
      return;
    }
    if (inOrder < prevOrder) return;
    if (incoming.percent > prev.progress.percent) {
      this.store.set(wikiId, { runId: prev.runId ?? rid, progress: incoming, updatedAt: ts });
      return;
    }
    if (incoming.percent < prev.progress.percent) return;
    const prevDone = prev.progress.completed + prev.progress.failed;
    const inDone = incoming.completed + incoming.failed;
    if (inDone > prevDone) {
      this.store.set(wikiId, { runId: prev.runId ?? rid, progress: incoming, updatedAt: ts });
    }
  }

  get(wikiId: string): IngestProgress | null {
    const entry = this.store.get(wikiId);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(wikiId);
      return null;
    }
    return entry.progress;
  }

  /**
   * Final state cleanup. If a runId (or one already present on the entry) is provided, add it to the cleared set and reject the late package of this generation.
   */
  clear(wikiId: string, runId?: string | null): void {
    const prev = this.store.get(wikiId);
    this.store.delete(wikiId);
    const rid = normalizeRunId(runId) ?? prev?.runId ?? null;
    if (rid) {
      let m = this.cleared.get(wikiId);
      if (!m) {
        m = new Map();
        this.cleared.set(wikiId, m);
      }
      m.set(rid, this.now());
    }
    this.pruneCleared(wikiId);
  }

  private isExpired(entry: StoreEntry): boolean {
    return this.now() - entry.updatedAt > this.ttlMs;
  }

  private pruneCleared(wikiId?: string): void {
    const cutoff = this.now() - this.ttlMs;
    const keys = wikiId ? [wikiId] : [...this.cleared.keys()];
    for (const id of keys) {
      const m = this.cleared.get(id);
      if (!m) continue;
      for (const [run, at] of m) {
        if (at < cutoff) m.delete(run);
      }
      if (m.size === 0) this.cleared.delete(id);
    }
  }
}

function normalizeRunId(runId: string | null | undefined): string | null {
  if (typeof runId !== 'string') return null;
  const t = runId.trim();
  return t.length > 0 ? t : null;
}
