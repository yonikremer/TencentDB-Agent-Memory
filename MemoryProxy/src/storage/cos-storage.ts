/**
 * CosStorage —— the object-storage implementation of ProxyStorage (COS / S3-compatible).
 *
 * Positioning: the first choice for production multi-instance deployments.
 *
 * Dependency injection: instead of directly `import COS from "cos-nodejs-sdk-v5"`, it plugs
 * into a minimal `CosLikeBackend` interface (PUT / GET / HEAD / DELETE / LIST); the factory
 * layer injects a real SDK instance. This way unit tests can verify all CosStorage logic
 * end-to-end with a mock backend, without touching a real bucket. In production, the
 * injected backend is the SharedCosClient wrapper of the openclaw plugin.
 *
 * Semantics at a glance:
 *   - putIfAbsent sends a COS `If-None-Match: "*"` header —— 412 if the key exists
 *   - TTL is enforced as a fallback by the bucket lifecycle rule (based on lastModified)
 *   - credential 403s / retry logic are the backend's responsibility, not handled here
 */
import type { ProxyStorage } from "./proxy-storage.js";

/**
 * CosLikeBackend contract —— **defined in cos-types.ts; re-exported here for backward
 * compatibility**.
 *
 * Production implementation: CosStorageBackendMultiSpace in the cost-guard submodule (loaded
 * via `await import("@context-proxy/cost-guard")`). Tests use an in-memory mock backend
 * (see cos-storage.test.ts).
 *
 * After the 2026-07-13 submodule split, cos-types.ts was added to carry CosLikeBackend +
 * KernelStsCosOptions; this file only re-exports them with unchanged signatures, so existing
 * callers `import { CosLikeBackend } from "./cos-storage.js"` are not broken.
 */
export type { CosLikeBackend } from "./cos-types.js";
import type { CosLikeBackend } from "./cos-types.js";

export class CosStorage implements ProxyStorage {
  readonly type = "cos" as const;

  constructor(private readonly backend: CosLikeBackend) {}

  async putText(key: string, value: string): Promise<void> {
    await this.backend.putObject(key, Buffer.from(value, "utf-8"));
  }

  async putJSON(key: string, value: unknown): Promise<void> {
    return this.putText(key, JSON.stringify(value));
  }

  async putTextIfAbsent(key: string, value: string): Promise<boolean> {
    try {
      await this.backend.putObject(key, Buffer.from(value, "utf-8"), { "If-None-Match": "*" });
      return true;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 412) return false; // Preconditions failed = key existed
      throw err;
    }
  }

  async putJSONIfAbsent(key: string, value: unknown): Promise<boolean> {
    return this.putTextIfAbsent(key, JSON.stringify(value));
  }

  async getText(key: string): Promise<string | null> {
    const buf = await this.backend.getObject(key);
    if (!buf) return null;
    return buf.toString("utf-8");
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
    return this.backend.headObject(key);
  }

  async del(key: string): Promise<void> {
    await this.backend.deleteObject(key);
  }

  async delPrefix(prefix: string): Promise<number> {
    const keys = await this.backend.listKeys(prefix);
    let n = 0;
    for (const k of keys) {
      await this.backend.deleteObject(k).catch(() => { /* best-effort */ });
      n++;
    }
    return n;
  }

  async listNames(prefix: string): Promise<string[]> {
    const keys = await this.backend.listKeys(prefix);
    return keys.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k));
  }
}
