/**
 * ProxyStorage — a unified KV abstraction replacing the ad-hoc direct Redis
 * calls scattered across the injection / Skill layers.
 *
 * See docs/design/2026-07-09-redis-to-cos-migration-plan.md §3.
 *
 * Semantics:
 *   - key is a relative path string, e.g. "short/inj-sess/abc.json". Absolute
 *     paths / path traversal are forbidden.
 *   - putJSON/putText overwrite; a successful write is equivalent to "renewal"
 *     (updates lastModified; only meaningful for ttl buckets).
 *   - putJSONIfAbsent/putTextIfAbsent are CAS: write only when the key does not
 *     exist, and return whether the write succeeded.
 *   - getJSON/getText return null when the key is not found; they do not throw.
 *   - delPrefix is used by clearBySession — implemented per backend.
 *   - listNames returns the basename of every object under prefix (prefix
 *     excluded).
 *
 * All methods are async; overwrites can be fire-and-forget (`.catch(() => {})`).
 * putIfAbsent must be awaited (its return value decides the subsequent branch).
 */
export type ProxyStorageType = "cos" | "sqlite" | "fs" | "memory";

export interface ProxyStorage {
  readonly type: ProxyStorageType;

  putJSON(key: string, value: unknown): Promise<void>;
  putText(key: string, value: string): Promise<void>;

  /** Atomic "put if absent". Returns true if this write succeeded; false if the key already exists. */
  putJSONIfAbsent(key: string, value: unknown): Promise<boolean>;
  putTextIfAbsent(key: string, value: string): Promise<boolean>;

  getJSON<T>(key: string): Promise<T | null>;
  getText(key: string): Promise<string | null>;
  exists(key: string): Promise<boolean>;

  del(key: string): Promise<void>;
  delPrefix(prefix: string): Promise<number>;

  listNames(prefix: string): Promise<string[]>;
}

/** Determine which bucket a key belongs to — used by the sweeper and the lifecycle rule generator. */
export function bucketOf(key: string): "ttl" | "nottl" {
  return key.startsWith("ttl/") ? "ttl" : "nottl";
}
