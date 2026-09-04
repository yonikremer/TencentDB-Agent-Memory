/**
 * QuotaManager — Quota Manager
 *
 * Responsibilities:
 * 1. Cache and check whether MemoryLimit / CreditLimit is exceeded
 * 2. Report usage changes via injected IQuotaReporter
 * 3. Locally cache Usage to avoid calling remote on every request
 *
 * Quota data source is determined by injected IQuotaReporter:
 *   - standalone: NoopQuotaReporter (fetchQuota returns null → treated as unlimited)
 *   - service:    Remote quota reporter injected by deployment environment
 */

import type { Logger } from "../logger.js";
import type { IQuotaReporter } from "../abstractions/index.js";

export interface QuotaConfig {
  memoryLimit: number;   // Total memory item count limit (default: 10000)
  creditLimit: number;   // Credit limit (default: 1000)
  memoryUsage: number;   // Current used memory item count
  creditUsage: number;   // Current used Credit
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: "memory_limit_exceeded" | "credit_limit_exceeded";
  current?: number;
  limit?: number;
}

export interface QuotaManagerOptions {
  /** Pre-constructed quota reporter for the current deployment. */
  reporter: IQuotaReporter;
  /** Quota cache TTL (ms), default 60s */
  cacheTtlMs?: number;
  /** Default MemoryLimit (used when upstream returns null/undefined) */
  defaultMemoryLimit?: number;
  /** Default CreditLimit (used when upstream returns null/undefined) */
  defaultCreditLimit?: number;
  logger: Logger;
}

const TAG = "[quota-manager]";

export class QuotaManager {
  private reporter: IQuotaReporter;
  private logger: Logger;
  private cacheTtlMs: number;
  private defaultMemoryLimit: number;
  private defaultCreditLimit: number;

  // Per-instance cache
  private cache = new Map<string, { config: QuotaConfig; expiresAt: number }>();

  constructor(opts: QuotaManagerOptions) {
    this.reporter = opts.reporter;
    this.logger = opts.logger;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.defaultMemoryLimit = opts.defaultMemoryLimit ?? 10_000;
    this.defaultCreditLimit = opts.defaultCreditLimit ?? 1_000;
  }

  /**
   * Get instance quota config (cached)
   *
   * When reporter.fetchQuota() returns null (open source / no quota mode), treated as unlimited —
   * returns memoryUsage=0/creditUsage=0 + defaultLimit, so all checks will pass.
   */
  async getQuota(instanceId: string): Promise<QuotaConfig> {
    const now = Date.now();
    const cached = this.cache.get(instanceId);
    if (cached && now < cached.expiresAt) {
      return cached.config;
    }

    try {
      const snapshot = await this.reporter.fetchQuota(instanceId);

      if (snapshot === null) {
        // No quota mode (Noop reporter): Return default limit + zero usage, will never exceed quota
        const config: QuotaConfig = {
          memoryLimit: this.defaultMemoryLimit,
          creditLimit: this.defaultCreditLimit,
          memoryUsage: 0,
          creditUsage: 0,
        };
        this.cache.set(instanceId, { config, expiresAt: now + this.cacheTtlMs });
        return config;
      }

      const config: QuotaConfig = {
        memoryLimit: snapshot.memoryLimit,
        creditLimit: snapshot.creditLimit,
        memoryUsage: snapshot.memoryUsage,
        creditUsage: snapshot.creditUsage,
      };
      this.cache.set(instanceId, { config, expiresAt: now + this.cacheTtlMs });
      return config;
    } catch (err) {
      this.logger.warn(`${TAG} Failed to fetch quota for ${instanceId}: ${err instanceof Error ? err.message : String(err)}`);
      return this.getDefaultOrCached(instanceId);
    }
  }

  /**
   * Check if writing memory is allowed (MemoryUsage < MemoryLimit)
   */
  async checkMemoryQuota(instanceId: string, delta: number = 1): Promise<QuotaCheckResult> {
    const quota = await this.getQuota(instanceId);
    // limit < 0 represents unlimited (compatible with control plane using -1 for unlimited).
    if (quota.memoryLimit >= 0 && quota.memoryUsage + delta > quota.memoryLimit) {
      return {
        allowed: false,
        reason: "memory_limit_exceeded",
        current: quota.memoryUsage,
        limit: quota.memoryLimit,
      };
    }
    return { allowed: true };
  }

  /**
   * Check if using LLM is allowed (CreditUsage < CreditLimit)
   */
  async checkCreditQuota(instanceId: string): Promise<QuotaCheckResult> {
    const quota = await this.getQuota(instanceId);
    // limit < 0 represents unlimited (compatible with control plane using -1 for unlimited).
    if (quota.creditLimit >= 0 && quota.creditUsage >= quota.creditLimit) {
      return {
        allowed: false,
        reason: "credit_limit_exceeded",
        current: quota.creditUsage,
        limit: quota.creditLimit,
      };
    }
    return { allowed: true };
  }

  /**
   * Report usage changes (via injected reporter)
   * @param memoryDelta Memory count delta (positive = add, negative = delete)
   * @param creditDelta Credit usage delta (positive = consume)
   * @param level Memory layer ("L0" | "L1" | "L2" | "L3" | "Skill")
   */
  async reportUsage(instanceId: string, memoryDelta: number, creditDelta: number, level: "L0" | "L1" | "L2" | "L3" | "Skill" = "L0"): Promise<void> {
    if (memoryDelta === 0 && creditDelta === 0) return;

    // Reporter internally guarantees no throws; try/catch here defensively in case contract is violated
    try {
      await this.reporter.reportUsage(instanceId, memoryDelta, creditDelta, level);

      // Synchronously update local cache (tracked locally regardless of whether reporter is noop or real)
      const cached = this.cache.get(instanceId);
      if (cached) {
        cached.config.memoryUsage += memoryDelta;
        cached.config.creditUsage += creditDelta;
      }

      this.logger.debug?.(`${TAG} Usage reported: instance=${instanceId}, memDelta=${memoryDelta}, creditDelta=${creditDelta}`);
    } catch (err) {
      // Defensive: reporter should not throw, but if it does it must not disrupt business logic
      this.logger.error(`${TAG} reportUsage unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Helper method: report memory addition
   */
  async reportMemoryAdded(instanceId: string, count: number, level: "L0" | "L1" | "L2" | "L3" = "L0"): Promise<void> {
    return this.reportUsage(instanceId, count, 0, level);
  }

  /**
   * Helper method: report memory deletion
   */
  async reportMemoryDeleted(instanceId: string, count: number, level: "L0" | "L1" | "L2" | "L3" = "L0"): Promise<void> {
    return this.reportUsage(instanceId, -count, 0, level);
  }

  /**
   * Helper method: report Credit consumption
   */
  async reportCreditUsed(instanceId: string, credits: number, level: "L0" | "L1" | "L2" | "L3" = "L1"): Promise<void> {
    return this.reportUsage(instanceId, 0, credits, level);
  }

  /**
   * Helper method: report Skill VDB addition (create skill / add version)
   */
  async reportSkillAdded(instanceId: string, count: number = 1): Promise<void> {
    return this.reportUsage(instanceId, count, 0, "Skill");
  }

  /**
   * Helper method: report Skill VDB deletion (soft delete / TTL cleanup)
   */
  async reportSkillDeleted(instanceId: string, count: number = 1): Promise<void> {
    return this.reportUsage(instanceId, -count, 0, "Skill");
  }

  /** Clear cache (for testing) */
  clearCache(): void {
    this.cache.clear();
  }

  private getDefaultOrCached(instanceId: string): QuotaConfig {
    const cached = this.cache.get(instanceId);
    if (cached) return cached.config; // Use expired old cache
    return {
      memoryLimit: this.defaultMemoryLimit,
      creditLimit: this.defaultCreditLimit,
      memoryUsage: 0,
      creditUsage: 0,
    };
  }
}
