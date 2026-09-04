/**
 * KvVersionPinRepo —— skill version pin (ProxyStorage-backed).
 *
 * See docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.2 §3.6.
 *
 * Key path:
 *   nottl/<spaceId>/<userId>/<agentSource>/<sessionId>/skill-vpin/<skillId>.txt
 *
 * spaceId is a new isolation segment added by P4 (kernel-sts). Old callers fall back to `_default` when passing an empty string.
 *
 * Key design differences vs the original Redis version:
 *   1. **Split keys**: from map-in-one-object to "one object per skill", eliminating R-M-W write amplification
 *      and concurrent-overwrite risk
 *   2. **CAS semantics**: `pinMany` uses `putTextIfAbsent` (COS If-None-Match / SQLite
 *      INSERT OR IGNORE / Fs O_EXCL / Memory Map.has), first write is authoritative,
 *      **no need to rely on sticky routing**
 *
 * `upsertVersion` is an overwrite (for the post-write scenario, when the plugin returns v+1).
 */
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { sessionDirOf, assertKeySegment } from "../storage/key-utils.js";

function vpinDir(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sessionDirOf("nottl", sp, userId, agentSource, sessionId)}skill-vpin/`;
}

function keyOf(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
  skillId: string,
): string {
  assertKeySegment("skillId", skillId);
  return `${vpinDir(spaceId, userId, agentSource, sessionId)}${skillId}.txt`;
}

export class KvVersionPinRepo {
  constructor(private readonly storage: ProxyStorage | null) {}

  async getVersion(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    skillId: string,
  ): Promise<number | null> {
    if (!this.storage) return null;
    try {
      const raw = await this.storage.getText(
        keyOf(spaceId, userId, agentSource, sessionId, skillId),
      );
      if (raw === null) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * First-access snapshot —— each (skillId, version) pair uses putTextIfAbsent, which is HSETNX semantics.
   * Silent degradation: no write failure throws, consistent with the original Redis version.
   */
  async pinMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    pairs: Array<{ skillId: string; version: number }>,
  ): Promise<void> {
    if (!this.storage || pairs.length === 0) return;
    await Promise.all(
      pairs.map((p) =>
        this.storage!
          .putTextIfAbsent(
            keyOf(spaceId, userId, agentSource, sessionId, p.skillId),
            String(p.version),
          )
          .catch(() => false),
      ),
    );
  }

  /** Forced overwrite after a write operation —— no CAS required. */
  async upsertVersion(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    skillId: string,
    version: number,
  ): Promise<void> {
    if (!this.storage) return;
    await this.storage
      .putText(keyOf(spaceId, userId, agentSource, sessionId, skillId), String(version))
      .catch(() => { /* silent */ });
  }
}
