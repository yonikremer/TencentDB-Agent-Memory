/**
 * KvBindingRepo —— BindingRepo backed by ProxyStorage.
 *
 * See docs/design/2026-08-03-binding-flatten.md:
 *   - Key path flattened: `nottl/<spaceId>/<sessionId>/binding.json`
 *   - JSON internal fields expanded to `userId/teamId/agentId/taskId/agentSource/userKey`,
 *     allowing bridge to reverse lookup complete identity just from (spaceId, sessionId)
 *
 * `touchLastSeen` changed from Redis HSET single field to layer R-M-W; using per-key mutex
 * to eliminate contention within a single node. In cross-node scenarios, last_seen might be overwritten and lost (acceptable for business).
 */
import type { BindingRepo, SessionBinding } from "./binding-repo.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { withPerKeyLock } from "../storage/per-key-mutex.js";
import { sessionBindingDirOf } from "../storage/key-utils.js";

function keyOf(spaceId: string, sessionId: string): string {
  const sp = spaceId || "_default";
  return `${sessionBindingDirOf("nottl", sp, sessionId)}binding.json`;
}

/**
 * lock key for per-key mutex. Originally isolated by 4 segments to prevent accidental serialization across users sharing sessionId,
 * after flattening (spaceId, sessionId) is the authoritative owner —— concurrent writes from different owners inherently
 * should serialize (last write wins, final result consistent with existing 4-segment scheme).
 */
function lockKey(spaceId: string, sessionId: string): string {
  const sp = spaceId || "_default";
  return `binding:${sp}:${sessionId}`;
}

interface StoredBinding {
  outcome: "initialized" | "bypassed";
  userId?: string;
  teamId?: string;
  agentId?: string;
  taskId?: string;
  agentSource?: string;
  userKey?: string;
  created_at: number;
  last_seen: number;
}

export class KvBindingRepo implements BindingRepo {
  constructor(private readonly storage: ProxyStorage) {}

  async getBinding(spaceId: string, sessionId: string): Promise<SessionBinding | null> {
    try {
      const raw = await this.storage.getJSON<StoredBinding>(keyOf(spaceId, sessionId));
      if (!raw) return null;
      return {
        outcome: raw.outcome ?? "initialized",
        userId: raw.userId,
        teamId: raw.teamId,
        agentId: raw.agentId,
        taskId: raw.taskId,
        agentSource: raw.agentSource,
        userKey: raw.userKey,
      };
    } catch {
      return null;
    }
  }

  async putBinding(spaceId: string, sessionId: string, binding: SessionBinding): Promise<void> {
    const key = keyOf(spaceId, sessionId);
    await withPerKeyLock(lockKey(spaceId, sessionId), async () => {
      const now = Date.now();
      const record: StoredBinding = {
        outcome: binding.outcome,
        userId: binding.userId,
        teamId: binding.teamId,
        agentId: binding.agentId,
        taskId: binding.taskId,
        agentSource: binding.agentSource,
        userKey: binding.userKey,
        created_at: now,
        last_seen: now,
      };
      // Preserve `created_at` on overwrite (equivalent to Redis HSET semantics: will not reset created_at)
      const existing = await this.storage.getJSON<StoredBinding>(key).catch(() => null);
      if (existing?.created_at) record.created_at = existing.created_at;
      await this.storage.putJSON(key, record).catch((err: any) => {
        // See KvSessionRepo.upsert's log explanation: fail must log, success no log
        console.warn(
          `[kv-binding] putBinding FAIL key=${key}: ` +
            `${err?.statusCode ?? ""} ${err?.code ?? ""} ${err?.message ?? String(err)}`,
        );
      });
    });
  }

  async deleteBinding(spaceId: string, sessionId: string): Promise<void> {
    const key = keyOf(spaceId, sessionId);
    await withPerKeyLock(lockKey(spaceId, sessionId), async () => {
      await this.storage.del(key).catch(() => { /* silent */ });
    });
  }

  async touchLastSeen(spaceId: string, sessionId: string): Promise<void> {
    const key = keyOf(spaceId, sessionId);
    await withPerKeyLock(lockKey(spaceId, sessionId), async () => {
      const cur = await this.storage.getJSON<StoredBinding>(key).catch(() => null);
      if (!cur) return;
      cur.last_seen = Date.now();
      await this.storage.putJSON(key, cur).catch(() => { /* silent */ });
    });
  }
}
