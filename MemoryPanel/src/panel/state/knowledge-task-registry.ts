/**
 * Knowledge extraction task memory state (temporary solution for this period, will be persisted in the next period).
 *
 * Background: The status-callback from KS → Panel is S2S, with no owner user_key,
 * Cannot directly call the kernel /v3/meta/asset/create as the owner (ForCaller routing requires
 * caller.user_id === owner_user_id）。So Panel in code-graph/create
 When initiated by the frontend with a user_key, temporarily store the owner key in memory, waiting for the callback
 When ready, extract and register the meta asset as owner.
 *
 * A process restart will lose tasks — a known corner case, covered by the frontend's register-meta to rebuild them,
 * It will be fully resolved after the next persistence implementation.
 */

export interface KnowledgeTask {
  knowledge_id: string;
  type: 'wiki' | 'code-graph';
  team_id: string;
  owner_user_id: string;
  /** callback S2S registers asset with owner identity when registering asset for meta API. */
  owner_user_key: string;
  service_id: string;
  created_at: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h: codegraph builds usually take a few minutes, leaving ample buffer

export class KnowledgeTaskRegistry {
  private readonly tasks = new Map<string, KnowledgeTask>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  record(task: KnowledgeTask): void {
    this.sweep();
    this.tasks.set(task.knowledge_id, task);
  }

  peek(knowledgeId: string): KnowledgeTask | undefined {
    this.sweep();
    return this.tasks.get(knowledgeId);
  }

  /** Retrieve and delete — called after callback registration succeeds, clearing completed tasks. */
  take(knowledgeId: string): KnowledgeTask | undefined {
    const t = this.tasks.get(knowledgeId);
    this.tasks.delete(knowledgeId);
    return t;
  }

  size(): number {
    return this.tasks.size;
  }

  /** Remove expired tasks to prevent leaks. Called along with record/peek. */
  sweep(now: number = Date.now()): void {
    for (const [id, t] of this.tasks) {
      if (now - t.created_at > this.ttlMs) this.tasks.delete(id);
    }
  }
}
