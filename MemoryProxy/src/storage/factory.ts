/**
 * ProxyStorage Factory — Singleton + Degradation Chain.
 *
 * See docs/design/2026-07-09-redis-to-cos-migration-plan.md §3.2.
 *
 * ⚠ cos is the only valid shared backend in a multi-node deployment: **if cos is configured, it must never degrade**. Assembly failure
 *   directly throws an error to prevent the process from starting. Otherwise, silently falling back to process-local (sqlite/fs/memory) will cause
 *   multiple nodes to write to their own local storage, resulting in cross-node state reading as empty (loss of session-init form, etc.).
 *   See docs/design/2026-07-13-proxy-multinode-state-audit.md P0-2.
 *
 * Non-cos backends (local / offline development) retain the degradation chain sqlite → fs → memory:
 *   - Each degradation console.error a `!!! DEGRADED !!!` message
 *   - `/health` exposes requested vs effective via `getEffectiveBackend()`
 *   - memory never fails but explicitly does not persist, serving only as a fallback to ensure the process does not crash.
 */
import { createRequire } from "node:module";
import type { ProxyStorage, ProxyStorageType } from "./proxy-storage.js";
import { MemoryStorage } from "./memory-storage.js";
import { FsStorage } from "./fs-storage.js";
import { SqliteStorage } from "./sqlite-storage.js";
import { CosStorage } from "./cos-storage.js";
import type { CosLikeBackend, KernelStsCosOptions } from "./cos-types.js";

const TAG = "[storage]";
const _require = createRequire(import.meta.url);

/**
 * User configuration structure — for the kernel-sts section, see
 * docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.1.
 *
 * COS backend only supports kernel-sts — static AK/SK has been removed (forbidden in production).
 * Local/offline development uses `backend: sqlite` (or fs / memory).
 */
export interface StorageConfig {
  backend: ProxyStorageType;
  /** The lifetime (in days) of objects under the `ttl/` prefix. Only takes effect for the ttl prefix. */
  ttlDays: number;

  cos: {
    /**
     * Business namespace prefix (isolated from core's memory_v2/cos_data).
     * Note: The CosUrl returned by Shark already includes bucket/region/endpointDomain,
     * no need to configure bucket/region here.
     */
    rootPrefix: string;
    /**
     * Optional: Force use VPC intranet / custom domain (e.g., `cos.example.com`).
     * If empty, uses the host from the CosUrl returned by Shark.
     */
    endpointDomain?: string;
    /** Configuration for fetching temporary credentials from Shark. */
    shark: {
      baseUrl: string;
      timeoutMs?: number;
      retryCount?: number;
      refreshBufferMs?: number;
      maxSpaces?: number;
      graceCloseDelayMs?: number;
    };
  };

  sqlite: {
    /** empty = use getDb() default (~/.tdai-memory-proxy/proxy.db) */
    dbPath: string;
  };

  fs: {
    fsRoot: string;
  };
}

let _instance: ProxyStorage | null = null;
let _requested: ProxyStorageType = "memory";
let _effective: ProxyStorageType = "memory";
let _lastError: string | undefined;
let _sweepTimer: NodeJS.Timeout | null = null;
/**
 * Currently active CosLikeBackend reference (non-null only when cos assembly is successful).
 * Kept so that `evictCosSpace()` can kick out the per-space backend in the kernel-sts pool
 * via the optional `evictSpace(spaceId)` hook; null for other backends / unassembled scenarios.
 */
let _cosBackend: CosLikeBackend | null = null;
/**
 * kernel-sts COS assembly entry point — dynamically imported from the cost-guard submodule.
 * Filled once during `initProxyStorage()`, then used by tryCreate.case("cos") for assembly.
 * null indicates the submodule is not loaded or unavailable — cos branch will follow the degradation chain.
 */
let _kernelStsFactory: ((opts: KernelStsCosOptions) => CosLikeBackend) | null = null;

/**
 * Called once at process startup — performs dynamic import of cost-guard then proceeds with synchronous getProxyStorage.
 *
 * If cost-guard is unavailable (open source users lack submodule / internal environment image build missed submodule update),
 * skips silently — the cos branch in getProxyStorage will throw, triggering the degradation chain (sqlite → fs → memory).
 *
 * See docs/design/2026-07-11-cos-submodule-extraction-plan.md §4.2 Decision 3.
 */
export async function initProxyStorage(config: StorageConfig): Promise<ProxyStorage> {
  if (_instance) return _instance;
  if (config.backend === "cos") {
    try {
      const mod = await import("@context-proxy/cost-guard");
      if (typeof mod.openKernelStsCosBackend === "function") {
        _kernelStsFactory = mod.openKernelStsCosBackend as (opts: KernelStsCosOptions) => CosLikeBackend;
      } else {
        console.warn(`${TAG} cost-guard loaded but openKernelStsCosBackend missing (version mismatch?)`);
      }
    } catch (err) {
      console.warn(
        `${TAG} cost-guard submodule unavailable — cos backend will fall back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return getProxyStorage(config);
}

export function getProxyStorage(config: StorageConfig): ProxyStorage {
  if (_instance) return _instance;
  _requested = config.backend;

  // ── cos：唯一正确的多节点共享后端，装配失败硬失败，绝不降级 ──────────────
  //
  // 一旦配了 cos，就不给降级链任何机会。cos 装配失败（cost-guard submodule
  // 缺失/版本不匹配、shark 不可达、STS 拉取失败等）必须直接抛错让进程起不来，
  // k8s 探活失败自然把这个坏 pod 摘掉。绝不能悄悄退到 process-local
  // （sqlite/fs/memory）——那会让多节点各写各的本地存储，跨节点 session
  // 状态互相读空，症状是"写到 COS 了但另一节点看不到 / session-init 表单被跳过"。
  // 见 docs/design/2026-07-13-proxy-multinode-state-audit.md P0-2。
  if (config.backend === "cos") {
    try {
      const created = tryCreate("cos", config);
      if (!created) throw new Error("cos backend factory returned null");
      console.log(`${TAG} activated cos backend`);
      _effective = "cos";
      _instance = created;
      startSweeperIfNeeded(created, config);
      return created;
    } catch (err) {
      _lastError = err instanceof Error ? err.message : String(err);
      console.error(
        `${TAG} !!! FATAL !!! backend cos init failed and fallback is DISABLED — ` +
          `cos is the only valid multi-node backend; refusing to degrade to ` +
          `process-local storage. Fix the deployment (cost-guard submodule / shark / STS) ` +
          `and restart. Cause: ${_lastError}`,
      );
      throw new Error(`${TAG} cos backend init failed (no fallback) — ${_lastError}`);
    }
  }

  // ── 非 cos：本地/离线开发，保留降级链 sqlite → fs → memory ────────────────
  const chain: ProxyStorageType[] = orderFrom(config.backend);
  for (const backend of chain) {
    try {
      const created = tryCreate(backend, config);
      if (!created) continue;
      if (backend !== _requested) {
        // 降级 = 高危事件，用 error 级别（老代码是 warn，被淹没了）
        console.error(
          `${TAG} !!! DEGRADED !!! backend ${_requested} unavailable — using ${backend} instead${_lastError ? ` (${_lastError})` : ""}`,
        );
        if (backend === "memory" || backend === "fs" || backend === "sqlite") {
          console.error(
            `${TAG} !!! MULTI-NODE HAZARD !!! effective backend=${backend} is process-local;`
            + ` other proxy nodes have their own copy — cross-node reads WILL miss.`,
          );
        }
      } else {
        console.log(`${TAG} activated ${backend} backend`);
      }
      _effective = backend;
      _instance = created;
      startSweeperIfNeeded(created, config);
      return created;
    } catch (err) {
      _lastError = err instanceof Error ? err.message : String(err);
      // 装配失败也升级为 error（之前是 warn）
      console.error(`${TAG} backend ${backend} init failed: ${_lastError}`);
    }
  }

  // 理论上到不了这里 —— MemoryStorage 不会抛
  console.error(
    `${TAG} !!! LAST-RESORT !!! all backends failed; falling back to in-process memory.`
    + ` Data will NOT persist across restarts and will NOT be visible to other nodes.`,
  );
  _instance = new MemoryStorage();
  _effective = "memory";
  return _instance;
}

export function getEffectiveBackend(): { requested: string; effective: string; error?: string } {
  return { requested: _requested, effective: _effective, error: _lastError };
}

/** 测试专用 —— 重置单例 + 停 sweeper。 */
export function __resetProxyStorageForTests(): void {
  _instance = null;
  _requested = "memory";
  _effective = "memory";
  _lastError = undefined;
  _cosBackend = null;
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}

/**
 * 踢掉 kernel-sts pool 里某个 spaceId 的 per-space backend + STS 凭证缓存。
 *
 * 触发场景：`/v3/instance/proxy-destroy` 清完 COS 数据后，主动回收该 space
 * 的 provider + cos client，避免 pool 里留着"已经无权限"的凭证等 LRU 淘汰。
 *
 * 语义（永不抛，用返回值区分）：
 *   - `"evicted"`      —— 成功从 pool 摘下并调度延迟 close
 *   - `"not-cached"`   —— cos 生效但 pool 里当前没有该 space（从没访问过 / 已淘汰）
 *   - `"unsupported"`  —— 当前 effective 不是 cos，或 cos backend 未暴露
 *                         `evictSpace` 钩子（例如未来主仓换 mock backend）
 */
export async function evictCosSpace(spaceId: string): Promise<"evicted" | "not-cached" | "unsupported"> {
  if (_effective !== "cos" || !_cosBackend || typeof _cosBackend.evictSpace !== "function") {
    return "unsupported";
  }
  const hit = await _cosBackend.evictSpace(spaceId);
  return hit ? "evicted" : "not-cached";
}

// ── internals ──────────────────────────────────────────────────────────────

function orderFrom(preferred: ProxyStorageType): ProxyStorageType[] {
  const all: ProxyStorageType[] = ["cos", "sqlite", "fs", "memory"];
  const start = all.indexOf(preferred);
  if (start < 0) return all;
  return all.slice(start);
}

function tryCreate(backend: ProxyStorageType, config: StorageConfig): ProxyStorage | null {
  switch (backend) {
    case "memory":
      return new MemoryStorage();
    case "fs": {
      if (!config.fs?.fsRoot) throw new Error("fs.fsRoot not configured");
      return new FsStorage(config.fs.fsRoot);
    }
    case "sqlite": {
      const db = openSqliteDb(config.sqlite?.dbPath);
      return new SqliteStorage(db);
    }
    case "cos": {
      if (!_kernelStsFactory) {
        throw new Error(
          "cost-guard submodule not loaded (call initProxyStorage() at startup, or submodule missing)",
        );
      }
      if (!config.cos.shark?.baseUrl) {
        throw new Error("shark.baseUrl required in kernel-sts mode");
      }
      const backendImpl = _kernelStsFactory(config.cos);
      // 存下 backend 引用，供 evictCosSpace() 走 optional evictSpace(spaceId) 钩子
      // （kernel-sts 装配的 CosStorageBackendMultiSpace 会实现它）。
      _cosBackend = backendImpl;
      return new CosStorage(backendImpl);
    }
  }
}

function openSqliteDb(dbPath: string): any {
  // Lazy require —— better-sqlite3 是 optional dependency，某些镜像加载会失败。
  let Database: any;
  try {
    Database = _require("better-sqlite3");
  } catch (err) {
    throw new Error(`better-sqlite3 unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (dbPath && dbPath.trim().length > 0) return new Database(dbPath);
  // 默认路径复用 db/index.ts 的 resolveDbPath 逻辑：环境变量 > ~/.tdai-memory-proxy/proxy.db。
  // 不通过 require ../db/index.js —— tsx 下 ESM 会失败 —— 直接内联一次。
  const os = _require("node:os");
  const path = _require("node:path");
  const fs = _require("node:fs");
  const fromEnv = process.env.PROXY_DB_PATH;
  const resolved =
    fromEnv && fromEnv.trim().length > 0
      ? fromEnv.trim()
      : path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  return new Database(resolved);
}

// kernel-sts COS 装配逻辑已迁到 cost-guard submodule
// (packages/cost-guard/src/storage/kernel-sts-factory.ts)。
// 主仓通过 initProxyStorage() dynamic import 拿到 _kernelStsFactory 使用。

function startSweeperIfNeeded(storage: ProxyStorage, config: StorageConfig): void {
  if (storage.type !== "sqlite") return;
  if (_sweepTimer) return; // already running
  const ttlMs = config.ttlDays * 86400 * 1000;
  const run = () => {
    try {
      // 只清 ttl bucket；nottl 永久保留（与 COS lifecycle rule 的语义一致）。
      (storage as SqliteStorage).sweep({ ttlMs });
    } catch (err) {
      console.warn(`${TAG} sweeper error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  _sweepTimer = setInterval(run, 5 * 60 * 1000);
  // don't hold the event loop just for the sweeper
  if (typeof _sweepTimer.unref === "function") _sweepTimer.unref();
}
