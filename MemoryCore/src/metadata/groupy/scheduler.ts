/**
 * Org-hierarchy-sync — scheduling + control-plane facade.
 *
 * DESIGN.md §5: on-boot sync, nightly GROUPY_CRON tick, manual trigger.
 * No cron dependency: matchesCron evaluates a 5-field expression in UTC
 * (deterministic across server timezones); the 60 s ticker fires at most
 * once per matching minute.
 */

import { MetadataError, type MetadataService } from "../service/metadata-service.js";
import { GroupyClient } from "./groupy-client.js";
import { MockGroupyClient } from "./mock-groupy-client.js";
import { HttpGroupyClient } from "./http-groupy-client.js";
import { runGroupySync, type GroupySyncSummary, type GroupyPostApplyResult, type GroupyPostApplyContext } from "./sync-service.js";
import type { GroupyConfig } from "./sync-config.js";
import type { GroupyRunEntity, GroupyNodeEntity, GroupyEdgeEntity } from "../types.js";
import type { SyncLogger } from "./sync-service.js";

const FIELD_LIMITS = [
  [0, 59], [0, 23], [1, 31], [1, 12], [0, 7],
] as const;

function parseField(field: string, min: number, max: number, expr: string): Set<number> {
  const out = new Set<number>();
  for (const alt of field.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(alt);
    if (!m) throw new Error(`invalid cron expression: ${expr}`);
    let from = min;
    let to = max;
    if (m[1] !== "*") {
      from = Number(m[1]);
      to = m[2] !== undefined ? Number(m[2]) : from;
    } else if (m[2] !== undefined) {
      to = Number(m[2]);
    }
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (from < min || to > max || from > to || step < 1) {
      throw new Error(`invalid cron expression: ${expr}`);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`invalid cron expression: ${expr}`);
  return out;
}

/** True when the 5-field cron expression matches `at` (evaluated in UTC). */
export function matchesCron(expr: string, at: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`invalid cron expression: ${expr}`);
  const sets = parts.map((p, i) => parseField(p, FIELD_LIMITS[i][0], FIELD_LIMITS[i][1], expr));
  const values = [at.getUTCMinutes(), at.getUTCHours(), at.getUTCDate(), at.getUTCMonth() + 1, at.getUTCDay()];
  return sets.every((set, i) => set.has(i === 4 && values[i] === 7 ? 0 : values[i]));
}

export interface GroupyStatus {
  enabled: boolean;
  roots: string[];
  cron: string;
  last_run: GroupyRunEntity | null;
  last_good_at: string | null;
  healthy: boolean;
}

export interface GroupyTree {
  nodes: GroupyNodeEntity[];
  edges: GroupyEdgeEntity[];
}

export interface GroupySummary {
  latest_run: GroupyRunEntity | null;
  archived_nodes: string[];
  revoked_grants: string[];
}

export interface GroupySchedulerOptions {
  service: MetadataService;
  config: GroupyConfig;
  logger?: SyncLogger;
  /** Test seam / adapter swap (DESIGN §13). */
  makeClient?: (config: GroupyConfig) => GroupyClient;
  /** P2 seam, forwarded to runGroupySync. */
  onMembershipApplied?: (ctx: GroupyPostApplyContext) => Promise<GroupyPostApplyResult>;
}

export interface StartOptions {
  tickMs?: number;
  runOnBoot?: boolean;
}

export function defaultMakeClient(config: GroupyConfig): GroupyClient {
  if (config.mockFile) return new MockGroupyClient(config.mockFile);
  return new HttpGroupyClient(config.baseUrl, config.token);
}

export class GroupyScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> | null = null;
  private lastFireKey = "";
  private running = false;
  private lastSummary: GroupySyncSummary | null = null;

  constructor(private readonly opts: GroupySchedulerOptions) {}

  get enabled(): boolean {
    return this.opts.config.enabled && this.opts.config.roots.length > 0;
  }

  /**
   * Begin on-boot sync (background) + cron ticker. No-op when disabled or
   * already started. The timer is unref'd so it never holds the process open.
   */
  start(startOpts: StartOptions = {}): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    if (startOpts.runOnBoot !== false) this.trigger();
    this.timer = setInterval(() => this.tick(new Date()), startOpts.tickMs ?? 60_000);
    const t = this.timer as unknown as { unref?: () => void };
    t.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
  }

  /** Resolves when any in-flight run settles (test hook). */
  async settled(): Promise<void> {
    await this.pending;
  }

  /** Manual trigger — throws groupy_disabled unless enabled. */
  async runNow(): Promise<GroupySyncSummary> {
    if (!this.enabled) {
      throw new MetadataError("groupy_disabled", "groupy sync is not enabled (GROUPY_ENABLED/GROUPY_ROOTS)");
    }
    const summary = await runGroupySync({
      client: this.opts.makeClient
        ? this.opts.makeClient(this.opts.config)
        : defaultMakeClient(this.opts.config),
      roots: this.opts.config.roots,
      service: this.opts.service,
      logger: this.opts.logger,
      onMembershipApplied: this.opts.onMembershipApplied,
    });
    this.lastSummary = summary;
    return summary;
  }

  async getStatus(): Promise<GroupyStatus> {
    const store = this.opts.service.rawStore;
    const latest = await store.getLatestGroupyRun();
    const lastGood = (await store.listGroupyRuns(50)).find((r) => r.status === "ok") ?? null;
    return {
      enabled: this.enabled,
      roots: this.opts.config.roots,
      cron: this.opts.config.cron,
      last_run: latest,
      last_good_at: lastGood?.finished_at ?? lastGood?.started_at ?? null,
      healthy: !this.enabled ? false : !latest ? true : latest.status === "ok",
    };
  }

  async getTree(): Promise<GroupyTree> {
    const store = this.opts.service.rawStore;
    return {
      nodes: await store.listGroupyNodes(true),
      edges: await store.listGroupyEdges(),
    };
  }

  async getSummary(): Promise<GroupySummary> {
    const store = this.opts.service.rawStore;
    const latest = await store.getLatestGroupyRun();
    const archived = (await store.listGroupyNodes(true))
      .filter((n) => n.archived)
      .map((n) => n.node_id);
    const revoked =
      latest && this.lastSummary?.run_id === latest.id ? this.lastSummary.revoked_grants : [];
    return { latest_run: latest, archived_nodes: archived, revoked_grants: revoked };
  }

  private trigger(): void {
    this.pending = this.runNow().then(
      () => undefined,
      (err) => this.opts.logger?.error?.(`[groupy-sync] background run failed: ${(err as Error).message}`),
    );
  }

  private tick(now: Date): void {
    let fire = false;
    try {
      fire = matchesCron(this.opts.config.cron, now);
    } catch (err) {
      this.opts.logger?.warn?.(`[groupy-sync] bad GROUPY_CRON, skipping tick: ${(err as Error).message}`);
      return;
    }
    const key = now.toISOString().slice(0, 16);
    if (fire && key !== this.lastFireKey) {
      this.lastFireKey = key;
      this.trigger();
    }
  }
}
