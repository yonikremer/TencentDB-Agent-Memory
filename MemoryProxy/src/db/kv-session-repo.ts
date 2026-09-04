/**
 * KvSessionRepo —— SessionRepo backed by ProxyStorage.
 *
 * See docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.2 §3.6.
 *
 * Key path:
 *   ttl/<spaceId>/<userId>/<agentSource>/<sessionId>/inj-sess.json
 *
 * spaceId is the isolation segment added in P4 (kernel-sts). When old callers pass an empty string, `_default` is used as fallback.
 *
 * `upsert` is async write-through —— L2a is guaranteed to be flushed to disk after caller `await` completes.
 * This is the direct basis for the 2026-07-13 fix "cross-node session-init intermediate state race → request passed through to LLM"
 * (under the original fire-and-forget semantics, when pod A closed the stream, COS PUT might still be flying,
 * and the turn-2 landing on pod B would fall into the tryHistoryScan fallback due to L2a miss → bypass).
 * Write failure keeps silent degradation: catch only warns, does not throw —— upper L1 remains authoritative.
 *
 * Read interface is async, miss returns null, does not throw.
 *
 * `loadAllInitialized`:
 *   - Under CosStorage backend, forcibly returns [] (disables startup hydrate, goes through probeL2a lazy loading)
 *   - SqliteStorage / FsStorage / MemoryStorage goes through listNames + getJSON,
 *     reverse resolving the 4-segment identity (spaceId, userId, agentSource, sessionId) from the key
 */
import type { SessionRepo, HydratedSessionRow } from "./sessionRepo.js";
import type { SessionInitState } from "../session/types.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { sessionDirOf } from "../storage/key-utils.js";

const TTL_BUCKET_PREFIX = "ttl/";
const MAIN_FILENAME = "inj-sess.json";

function mainKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sessionDirOf("ttl", sp, userId, agentSource, sessionId)}${MAIN_FILENAME}`;
}

export class KvSessionRepo implements SessionRepo {
  constructor(private readonly storage: ProxyStorage) {}

  async upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<void> {
    // Calculate key in advance —— assertKeySegment / assertAgentSource validation will throw synchronously here,
    // allowing caller to observe invalid parameters at the assembly layer (instead of becoming a silent async failure).
    const key = mainKey(spaceId, userId, agentSource, sessionId);
    try {
      await this.storage.putJSON(key, state);
    } catch (err) {
      // Silent degradation: L1 remains authoritative write-through target; L2a write failure does not block main flow.
      const e = err as { statusCode?: number; code?: string; message?: string };
      console.warn(
        `[kv-session] upsert FAIL key=${key}: ` +
          `${e?.statusCode ?? ""} ${e?.code ?? ""} ${e?.message ?? String(err)}`,
      );
    }
  }

  async getBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionInitState | null> {
    try {
      return await this.storage.getJSON<SessionInitState>(
        mainKey(spaceId, userId, agentSource, sessionId),
      );
    } catch {
      return null;
    }
  }

  deleteBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): void {
    this.storage
      .del(mainKey(spaceId, userId, agentSource, sessionId))
      .catch(() => { /* silent */ });
  }

  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    // Under CosStorage disable startup hydrate —— full listObjects is too slow and of limited value
    // (under multi-node can only cover the first request of the current node). Go through probeL2a lazy loading instead.
    if (this.storage.type === "cos") return [];

    try {
      // listNames passing "ttl/" prefix, the returned name is the path after removing the prefix,
      // expecting format like "<spaceId>/<userId>/<agentSource>/<sessionId>/inj-sess.json".
      const names = await this.storage.listNames(TTL_BUCKET_PREFIX);
      const out: HydratedSessionRow[] = [];
      const suffix = `/${MAIN_FILENAME}`;
      for (const name of names) {
        if (!name.endsWith(suffix)) continue;
        const stem = name.slice(0, -suffix.length);
        const segs = stem.split("/");
        if (segs.length !== 4) continue;
        const [spaceId, userId, agentSource, sessionId] = segs;
        const state = await this.storage.getJSON<SessionInitState>(
          TTL_BUCKET_PREFIX + name,
        );
        if (!state || state.status !== "initialized") continue;
        out.push({ spaceId, userId, agentSource, sessionId, state });
      }
      return out;
    } catch {
      return [];
    }
  }
}
