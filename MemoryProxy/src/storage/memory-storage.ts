/**
 * MemoryStorage — the in-process Map implementation of ProxyStorage.
 *
 * Purpose: fallback backend. When cos/sqlite/fs are all unavailable, keeps the proxy
 * from crashing, matching today's "nothing configured" behavior. **Not for production**.
 *
 * TTL: no sweeper for now (the memory backend is used only as a fallback / for unit tests —
 * it disappears on process restart).
 *
 * Production observability: every write logs one error line throttled to 60s intervals, to
 * remind ops that the current state is a dangerous fallback. See docs/design/2026-07-13-proxy-multinode-state-audit.md P0-2.
 */
import type { ProxyStorage } from "./proxy-storage.js";

interface Entry {
  value: Buffer;
  updatedAt: number;
}

const TAG = "[storage/memory]";
const WARN_INTERVAL_MS = 60_000;

export class MemoryStorage implements ProxyStorage {
  readonly type = "memory" as const;
  private data = new Map<string, Entry>();
  private lastWarnAt = 0;
  private opsSinceLastWarn = 0;

  /**
   * Throttled warning, at most once per 60s — called on every write; it accumulates a
   * count and only actually logs once 60s have elapsed.
   * Purpose: when multiple nodes silently degrade to memory, ops can see the write volume
   * in the logs and won't miss it because of warn-once (the old implementation warned only once, then went silent).
   */
  private warnUsage(op: string): void {
    this.opsSinceLastWarn++;
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    console.error(
      `${TAG} !!! IN-MEMORY STORAGE ACTIVE !!! ${this.opsSinceLastWarn} ops in last`
      + ` ${Math.round((now - this.lastWarnAt) / 1000)}s (latest: ${op}). Data will NOT persist`
      + ` and is NOT visible to other proxy nodes.`,
    );
    this.lastWarnAt = now;
    this.opsSinceLastWarn = 0;
  }

  async putText(key: string, value: string): Promise<void> {
    this.warnUsage("putText");
    this.data.set(key, { value: Buffer.from(value, "utf-8"), updatedAt: Date.now() });
  }

  async putJSON(key: string, value: unknown): Promise<void> {
    return this.putText(key, JSON.stringify(value));
  }

  async putTextIfAbsent(key: string, value: string): Promise<boolean> {
    // JS is single-threaded — no race between has/set
    if (this.data.has(key)) return false;
    // putText would double-count the warning, so set directly and count once instead
    this.warnUsage("putTextIfAbsent");
    this.data.set(key, { value: Buffer.from(value, "utf-8"), updatedAt: Date.now() });
    return true;
  }

  async putJSONIfAbsent(key: string, value: unknown): Promise<boolean> {
    return this.putTextIfAbsent(key, JSON.stringify(value));
  }

  async getText(key: string): Promise<string | null> {
    const e = this.data.get(key);
    return e ? e.value.toString("utf-8") : null;
  }

  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.getText(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async del(key: string): Promise<void> {
    this.warnUsage("del");
    this.data.delete(key);
  }

  async delPrefix(prefix: string): Promise<number> {
    this.warnUsage("delPrefix");
    let n = 0;
    for (const k of this.data.keys()) {
      if (k.startsWith(prefix)) {
        this.data.delete(k);
        n++;
      }
    }
    return n;
  }

  async listNames(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (const k of this.data.keys()) {
      if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
    return out;
  }
}
