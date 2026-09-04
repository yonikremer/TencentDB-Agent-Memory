/**
 * BindingRepo — long-term session binding persistence.
 *
 * Stores a "little note" in KV, only recording outcome + id group, never automatically cleared (`nottl/` prefix).
 * Used for waking up sleeping conversations + memory bridge L2 reverse lookup identity.
 *
 * ── Signature note ────────────────────────────────────────────────────────
 * See docs/design/2026-08-03-binding-flatten.md:
 *   - Original scheme (2026-07-10) used `(userId, agentSource, sessionId)` 3-segment as key,
 *     plus P4 (2026-07-12 kernel-sts)'s `spaceId` making 4 segments total
 *   - But curl on the bridge side can only give (spaceId, sessionId) —— cannot get userId/agentSource,
 *     when cross-pod L1 misses, the old key can never be assembled, 401 all the way
 *   - After flattening: method signature reduced to `(spaceId, sessionId)`, userId/agentSource moved to
 *     `SessionBinding` struct, `userKey` is also stored together (after memory-bridge L2b
 *     recovers, chat_memory retrieval no longer downgrades)
 */

import type { Redis } from "ioredis";

const REDIS_KEY_PREFIX = "inj:binding:";
const DEFAULT_BINDING_TTL_DAYS = 30;

export interface SessionBinding {
  outcome: "initialized" | "bypassed";
  userId?: string;
  teamId?: string;
  agentId?: string;
  taskId?: string;
  /**
   * agent prefix on the URL path side (`claude-code` / `codebuddy` ...). When session init
   * falls to disk, brought over from identity, used by bridge reverse lookup to stamp to outbound.
   */
  agentSource?: string;
  /**
   * User apiKey. memory-bridge needs it when recovering chat_memory retrieval to query kernel
   * for imported agents (see `memory-bridge.ts:resolveMemoryCtxs`), missing it
   * will silently downgrade to self-only. The old 4-segment path does not carry this field, must downgrade after recovery ——
   * stored together after flattening, fixed along the way.
   */
  userKey?: string;
}

export interface BindingRepo {
  getBinding(spaceId: string, sessionId: string): Promise<SessionBinding | null>;
  putBinding(spaceId: string, sessionId: string, binding: SessionBinding): Promise<void>;
  deleteBinding(spaceId: string, sessionId: string): Promise<void>;
  touchLastSeen(spaceId: string, sessionId: string): Promise<void>;
}

function ttlSeconds(days: number): number {
  return days * 86400;
}

function redisKey(spaceId: string, sessionId: string): string {
  const sp = spaceId || "_default";
  return `${REDIS_KEY_PREFIX}${sp}:${sessionId}`;
}

export class RedisBindingRepo implements BindingRepo {
  constructor(
    private redis: Redis,
    private bindingTtlDays: number = DEFAULT_BINDING_TTL_DAYS,
  ) {}

  async getBinding(spaceId: string, sessionId: string): Promise<SessionBinding | null> {
    try {
      const all = await this.redis.hgetall(redisKey(spaceId, sessionId));
      if (!all || Object.keys(all).length === 0) return null;
      return {
        outcome: (all.outcome as "initialized" | "bypassed") || "initialized",
        userId: all.user_id || undefined,
        teamId: all.team_id || undefined,
        agentId: all.agent_id || undefined,
        taskId: all.task_id || undefined,
        agentSource: all.agent_source || undefined,
        userKey: all.user_key || undefined,
      };
    } catch {
      return null;
    }
  }

  async putBinding(spaceId: string, sessionId: string, binding: SessionBinding): Promise<void> {
    const now = Date.now().toString();
    try {
      const fields: Record<string, string> = {
        outcome: binding.outcome,
        created_at: now,
        last_seen: now,
      };
      if (binding.userId) fields.user_id = binding.userId;
      if (binding.teamId) fields.team_id = binding.teamId;
      if (binding.agentId) fields.agent_id = binding.agentId;
      if (binding.taskId) fields.task_id = binding.taskId;
      if (binding.agentSource) fields.agent_source = binding.agentSource;
      if (binding.userKey) fields.user_key = binding.userKey;

      const key = redisKey(spaceId, sessionId);
      await this.redis.hset(key, fields);
      await this.redis.expire(key, ttlSeconds(this.bindingTtlDays));
    } catch {
      /* ignore */
    }
  }

  async deleteBinding(spaceId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.del(redisKey(spaceId, sessionId));
    } catch {
      /* ignore */
    }
  }

  async touchLastSeen(spaceId: string, sessionId: string): Promise<void> {
    try {
      const key = redisKey(spaceId, sessionId);
      await this.redis.hset(key, "last_seen", Date.now().toString());
      await this.redis.expire(key, ttlSeconds(this.bindingTtlDays));
    } catch {
      /* ignore */
    }
  }
}

/** Null repo for when Redis is disabled. */
export class NullBindingRepo implements BindingRepo {
  async getBinding(_spaceId: string, _sessionId: string): Promise<SessionBinding | null> { return null; }
  async putBinding(_spaceId: string, _sessionId: string, _binding: SessionBinding): Promise<void> {}
  async deleteBinding(_spaceId: string, _sessionId: string): Promise<void> {}
  async touchLastSeen(_spaceId: string, _sessionId: string): Promise<void> {}
}
