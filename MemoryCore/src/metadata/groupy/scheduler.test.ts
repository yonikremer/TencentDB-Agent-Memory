/**
 * Org-hierarchy-sync P1 — scheduler tests (TDD).
 * DESIGN.md §4.3/§5: on-boot + nightly (GROUPY_CRON) + manual trigger.
 */
import { describe, it, expect } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import { GroupyClient, type GroupyNodeData } from "./groupy-client.js";
import { matchesCron, GroupyScheduler } from "./scheduler.js";
import type { GroupyConfig } from "./sync-config.js";

function d(minute: number, hour: number): Date {
  return new Date(Date.UTC(2026, 8, 7, hour, minute, 0));
}

describe("matchesCron", () => {
  it("nightly default fires at 02:00 only", () => {
    expect(matchesCron("0 2 * * *", d(0, 2))).toBe(true);
    expect(matchesCron("0 2 * * *", d(1, 2))).toBe(false);
    expect(matchesCron("0 2 * * *", d(0, 3))).toBe(false);
  });
  it("steps, lists, ranges", () => {
    expect(matchesCron("*/15 * * * *", d(30, 9))).toBe(true);
    expect(matchesCron("*/15 * * * *", d(31, 9))).toBe(false);
    expect(matchesCron("0 2,14 * * *", d(0, 14))).toBe(true);
    expect(matchesCron("0 9-17 * * *", d(0, 12))).toBe(true);
    expect(matchesCron("0 9-17 * * *", d(0, 18))).toBe(false);
  });
  it("rejects malformed expressions", () => {
    expect(() => matchesCron("0 2 * *", d(0, 2))).toThrow();
    expect(() => matchesCron("xx 2 * * *", d(0, 2))).toThrow();
  });
});

class StubClient extends GroupyClient {
  runs = 0;
  async fetchNode(id: string): Promise<GroupyNodeData> {
    this.runs += 1;
    return { id, name: id, display_name: id, members: [] };
  }
}

function enabledCfg(over: Partial<GroupyConfig> = {}): GroupyConfig {
  return {
    enabled: true, baseUrl: "", token: "", roots: ["r"],
    cron: "0 2 * * *", mockFile: "", ...over,
  };
}

async function setup(cfg: GroupyConfig, client: StubClient): Promise<GroupyScheduler> {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  const service = new MetadataService(store);
  return new GroupyScheduler({ service, config: cfg, makeClient: () => client });
}

describe("GroupyScheduler", () => {
  it("disabled scheduler neither boots nor runs", async () => {
    const client = new StubClient();
    const sched = await setup(enabledCfg({ enabled: false }), client);
    sched.start();
    await sched.settled();
    expect(client.runs).toBe(0);
    await expect(sched.runNow()).rejects.toThrowError(
      expect.objectContaining({ code: "groupy_disabled" }),
    );
    expect((await sched.getStatus()).enabled).toBe(false);
    sched.stop();
  });

  it("start() runs on-boot sync; status/tree/summary served from store", async () => {
    const client = new StubClient();
    const sched = await setup(enabledCfg(), client);
    sched.start();
    await sched.settled();
    expect(client.runs).toBe(1);
    const status = await sched.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.last_run?.status).toBe("ok");
    expect(status.healthy).toBe(true);
    const tree = await sched.getTree();
    expect(tree.nodes.map((n) => n.node_id)).toEqual(["r"]);
    const summary = await sched.getSummary();
    expect(summary.latest_run?.status).toBe("ok");
    expect(summary.archived_nodes).toEqual([]);
    sched.stop();
  });

  it("cron tick fires on match and stop() halts", async () => {
    const client = new StubClient();
    const sched = await setup(enabledCfg({ cron: "* * * * *" }), client);
    sched.start({ tickMs: 20, runOnBoot: false });
    await new Promise((r) => setTimeout(r, 120));
    sched.stop();
    const afterStop = client.runs;
    expect(afterStop).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(client.runs).toBe(afterStop);
  });
});
