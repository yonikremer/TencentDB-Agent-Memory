/**
 * auto-sync-scheduler.test.ts — scheduler behavior with fake store/service.
 *
 * Status lifecycle, triggerScan candidate selection (ready only, dedupe),
 * worker drains queue via cgService.sync, stop() halts, disabled start()
 * is a no-op. No timers waited (triggerScan drives scans directly).
 */
import { describe, it, expect, afterEach } from "vitest";
import { AutoSyncScheduler } from "./auto-sync-scheduler.js";

const READY = {
  service_id: "s",
  team_id: "t",
  code_graph_id: "cg-ready01",
  status: "ready",
};
const BUSY = {
  service_id: "s",
  team_id: "t",
  code_graph_id: "cg-busy0001",
  status: "syncing",
};

function fakes() {
  const synced: Array<{
    service_id: string;
    team_id: string;
    code_graph_id: string;
  }> = [
    { service_id: "s", team_id: "t", code_graph_id: "cg-ready01" },
    { service_id: "s", team_id: "t", code_graph_id: "cg-busy0001" },
  ];
  const rows = new Map([
    ["cg-ready01", READY],
    ["cg-busy0001", BUSY],
  ]);
  const syncCalls: string[] = [];
  const store = {
    listSyncedCodeGraphs: () => synced,
    getCodeGraph: (svc: string, team: string, id: string) =>
      rows.get(id) ?? null,
  };
  const cgService = {
    sync: async (_svc: string, _team: string, id: string) => {
      syncCalls.push(id);
      return { kind: "ok" };
    },
  };
  return { store, cgService, syncCalls };
}

function sched(maxConcurrentSyncs = 1) {
  const { store, cgService, syncCalls } = fakes();
  const s = new AutoSyncScheduler({
    store: store as never,
    cgService: cgService as never,
    config: { enabled: true, scanIntervalMs: 60_000, maxConcurrentSyncs },
  });
  return { s, syncCalls };
}

async function waitFor(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms)
      throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

let active: AutoSyncScheduler[] = [];
afterEach(() => {
  for (const s of active) {
    try {
      s.stop();
    } catch {
      /* ignore */
    }
  }
  active = [];
});

describe("status lifecycle", () => {
  it("starts stopped; start() flips running", () => {
    const { s } = sched();
    active.push(s);
    expect(s.getStatus()).toMatchObject({ running: false, scanning: false });
    s.start();
    expect(s.getStatus().running).toBe(true);
  });

  it("disabled config start() stays stopped", () => {
    const { store, cgService } = fakes();
    const s = new AutoSyncScheduler({
      store: store as never,
      cgService: cgService as never,
      config: { enabled: false, scanIntervalMs: 1000, maxConcurrentSyncs: 1 },
    });
    active.push(s);
    s.start();
    expect(s.getStatus().running).toBe(false);
  });
});

describe("triggerScan + workers", () => {
  it("enqueues ready repos only; worker syncs and drains", async () => {
    const { s, syncCalls } = sched();
    active.push(s);
    s.start();
    s.triggerScan();
    await waitFor(() => syncCalls.length === 1);
    expect(syncCalls).toEqual(["cg-ready01"]);
    await waitFor(
      () => s.getStatus().queueLength === 0 && s.getStatus().activeSyncs === 0,
    );
  });

  it("double trigger does not double-sync (in-flight dedupe)", async () => {
    const { s, syncCalls } = sched();
    active.push(s);
    s.start();
    s.triggerScan();
    s.triggerScan();
    await waitFor(() => syncCalls.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(syncCalls).toEqual(["cg-ready01"]);
  });

  it("stop() halts workers", async () => {
    const { s, syncCalls } = sched();
    active.push(s);
    s.start();
    s.triggerScan();
    await waitFor(() => syncCalls.length === 1);
    s.stop();
    expect(s.getStatus().running).toBe(false);
  });
});
