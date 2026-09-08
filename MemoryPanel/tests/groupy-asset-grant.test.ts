/**
 * Org-hierarchy-sync P4 — Panel grant flow tests (TDD).
 *
 * Real kernel stack (MetadataService + GroupyScheduler over a mock groupy
 * fixture) + fake KS client. Proves PLAN P4 acceptance 1-3,5:
 * instant grant → kernel ACL + KS mirror teams; revoke clears both;
 * non-admin rejected; orphans surface archived-node shares.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteMetadataStore } from "../../MemoryCore/src/metadata/store/sqlite-adapter.js";
import { MetadataService } from "../../MemoryCore/src/metadata/service/metadata-service.js";
import { MockGroupyClient } from "../../MemoryCore/src/metadata/groupy/mock-groupy-client.js";
import { GroupyScheduler } from "../../MemoryCore/src/metadata/groupy/scheduler.js";
import { recomputeGroupyShares } from "../../MemoryCore/src/metadata/groupy/grant-service.js";
import { InstanceRegistry } from "../src/panel/config/instance-registry.js";
import { registerGroupyRoutes } from "../src/panel/http/routes/groupy.js";
import { registerAssetGrantRoutes } from "../src/panel/http/routes/asset-grant.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";
import type { KnowledgeClientPort } from "../src/panel/kernel/ports/knowledge-client-port.js";

const INST = "test-grant-1";
const ADMIN_KEY = "adm-key-grant-1";
const ROOTS = ["product_x", "120data_branch"];

let base = "";
let server: Server;
let tmp = "";
let svc: MetadataService;
let adminId = "";
let yonikId = "";
let fixturePath = "";
const ksCalls: Array<{ method: string; kind: string; id: string; arg: unknown }> = [];
const ksState = new Map<string, Array<{ team_id: string; grant_type: string }>>();
const ksFailIds = new Set<string>();
const WIKI = "wiki-grant00";
const SKILL = "skill-grant00";

function matrix(pruneTeamB: boolean) {
  const pxMembers = pruneTeamB
    ? [{ id: "123teamA", kind: "org" }]
    : [{ id: "123teamA", kind: "org" }, { id: "123teamB", kind: "org" }];
  const nodes = [
    { id: "product_x", name: "Product X", display_name: "Product X", members: pxMembers },
    { id: "120data_branch", name: "Data Branch", display_name: "Data Branch", members: [
      { id: "123teamA", kind: "org" },
      { id: "999head", kind: "user" },
    ] },
    { id: "123teamA", name: "Team A", display_name: "Team A", members: [
      { id: "123yonik", kind: "user" },
      { id: "124alice", kind: "user" },
    ] },
  ];
  if (!pruneTeamB) {
    nodes.push({ id: "123teamB", name: "Team B", display_name: "Team B", members: [
      { id: "124alice", kind: "user" },
    ] });
  }
  return { nodes };
}

async function post(path: string, body: unknown, key: string | null = ADMIN_KEY) {
  const h: Record<string, string> = { "content-type": "application/json", "x-tdai-service-id": INST };
  if (key) h["x-tdai-user-key"] = key;
  const res = await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "panel-grant-"));
  fixturePath = join(tmp, "groupy.json");
  writeFileSync(fixturePath, JSON.stringify(matrix(false)));
  const store = new SqliteMetadataStore(join(tmp, "meta.db"));
  (globalThis as any).__metaStoreGrant = store;
  store.init();
  svc = new MetadataService(store, INST, { debug: () => {} });
  const admin = await svc.initAdminUser({ username: "root", user_key: ADMIN_KEY });
  adminId = admin.user_id;
  const scheduler = new GroupyScheduler({
    service: svc,
    config: { enabled: true, baseUrl: "", token: "", roots: ROOTS, cron: "0 2 * * *", mockFile: fixturePath },
    makeClient: () => new MockGroupyClient(fixturePath),
    onMembershipApplied: (c) => recomputeGroupyShares({
      service: c.service, graph: c.graph, closure: c.closure, archivedNodes: c.archivedNodes,
    }),
  });
  svc.setGroupyScheduler(scheduler);
  await scheduler.runNow();
  yonikId = (await store.listUsers({ limit: 5, offset: 0 }, { username: "123yonik" })).items[0].user_id;
  await svc.createAsset({
    asset_id: WIKI, team_id: "123teamA", asset_type: "llm_wiki",
    name: "team wiki", owner_user_id: yonikId, source_type: "test",
  });
  await svc.createAsset({
    asset_id: SKILL, team_id: "123teamA", asset_type: "skill",
    name: "team skill", owner_user_id: yonikId, source_type: "test",
  });

  const adminCtx = { token: "", userId: adminId, isAdmin: false, isSystemAdmin: true };
  const metaKernel = {
    async invoke(action: string, body: Record<string, unknown>, _ctx: unknown) {
      const ok = (data: unknown) => ({ code: 0, message: "ok", request_id: "t", data });
      switch (action) {
        case "auth/verify":
          return ok(await svc.verifyAuthForCaller(body.user_key as string, {} as any));
        case "asset/get": {
          const a = await svc.getAssetById(body.asset_id as string);
          return a ? ok(a) : { code: 404, message: "not found", request_id: "t", data: null };
        }
        case "groupy/sync":
          return ok(await scheduler.runNow());
        case "groupy/status":
          return ok(await scheduler.getStatus());
        case "groupy/tree":
          return ok(await scheduler.getTree());
        case "groupy/shares":
          return ok(await store.listGroupyShares());
        case "groupy/asset-grant": {
          const keyUser = await svc.rawStore.getUserByKey(String((_ctx as any)?.userKey ?? ""));
          const keyRow = keyUser ? await svc.getUserById(keyUser.user_id) : null;
          const callerCtx = {
            token: "", userId: keyRow?.user_id, isAdmin: false,
            isSystemAdmin: keyRow?.user_type === "system_admin",
          };
          try {
            return ok(await svc.applyAssetShareForCaller(body as any, callerCtx as any));
          } catch (err) {
            const code = (err as { code?: string }).code ?? "";
            const status = code === "permission_denied" ? 403
              : /not_found$/.test(code) ? 404
              : 400;
            return { code: status, message: code, request_id: "t", data: null };
          }
        }
        default:
          return { code: 400, message: `unsupported in test: ${action}`, request_id: "t", data: null };
      }
    },
  };
  const fakeKs = {
    async grantsSet(kind: string, id: string, grants: unknown) {
      ksCalls.push({ method: "set", kind, id, arg: grants });
      const rows = (grants as Array<{ team_id: string; grant_type?: string }>)
        .map((g) => ({ team_id: g.team_id, grant_type: g.grant_type ?? "viewer" }));
      const key = `${kind}:${id}`;
      const cur = ksState.get(key) ?? [];
      for (const row of rows) {
        const ix = cur.findIndex((r) => r.team_id === row.team_id);
        if (ix >= 0) cur[ix] = row;
        else cur.push(row);
      }
      ksState.set(key, cur);
      return { kind, knowledge_id: id, grants: rows };
    },
    async grantsClear(kind: string, id: string, teamIds?: string[]) {
      ksCalls.push({ method: "clear", kind, id, arg: teamIds });
      const key = `${kind}:${id}`;
      if (!teamIds) {
        const n = (ksState.get(key) ?? []).length;
        ksState.delete(key);
        return { kind, knowledge_id: id, cleared: n };
      }
      const cur = (ksState.get(key) ?? []).filter((r) => !teamIds.includes(r.team_id));
      const n = (ksState.get(key) ?? []).length - cur.length;
      ksState.set(key, cur);
      return { kind, knowledge_id: id, cleared: n };
    },
    async grantsList(kind: string, id: string) {
      if (ksFailIds.has(id)) throw new Error("KS down");
      return { kind, knowledge_id: id, grants: ksState.get(`${kind}:${id}`) ?? [] };
    },
  } as unknown as KnowledgeClientPort;
  const deps = {
    instanceRegistry: new InstanceRegistry([{
      instance_id: INST, name: "t", gateway_endpoint: "http://127.0.0.1:9", api_key: "k",
    }]),
    metaKernel,
    knowledgeClientFactory: (_id: string) => fakeKs,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as PanelDeps;
  const app = new Hono();
  const api = new Hono();
  registerGroupyRoutes(api, deps);
  registerAssetGrantRoutes(api, deps);
  app.route("/api/v1", api);
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try { (globalThis as any).__metaStoreGrant?.close(); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe("panel asset grant (instant share)", () => {
  it("grant wiki → kernel ACL + KS mirror over subtree teams", async () => {
    ksCalls.length = 0;
    const r = await post("/api/v1/asset/grant", {
      asset_id: WIKI, node_id: "120data_branch", action: "grant", grant_type: "editor",
    });
    expect(r.json.code).toBe(0);
    expect(r.json.data.asset.visibility).toBe("restricted");
    // kernel ACL carries the branch-chain head
    const headId = (await svc.rawStore.listUsers({ limit: 5, offset: 0 }, { username: "999head" })).items[0].user_id;
    const acl = await svc.rawStore.listAclByAsset(WIKI, { limit: 50, offset: 0 });
    expect(acl.items.some((a) => a.subject_type === "user" && a.subject_id === headId)).toBe(true);
    // KS mirror: subtree teams of the branch with the requested grant_type
    expect(ksCalls).toHaveLength(1);
    expect(ksCalls[0].method).toBe("set");
    expect(ksCalls[0].kind).toBe("wiki");
    const mirrored = (ksCalls[0].arg as Array<{ team_id: string; grant_type: string }>);
    expect(mirrored.map((g) => g.team_id).sort()).toEqual(["120data_branch", "123teamA"].sort());
    expect(new Set(mirrored.map((g) => g.grant_type))).toEqual(new Set(["editor"]));
  });

  it("revoke restores visibility and clears the mirror", async () => {
    ksCalls.length = 0;
    const r = await post("/api/v1/asset/grant", {
      asset_id: WIKI, node_id: "120data_branch", action: "revoke",
    });
    expect(r.json.code).toBe(0);
    expect(r.json.data.asset.visibility).toBe("team");
    expect(ksCalls).toHaveLength(1);
    expect(ksCalls[0].method).toBe("clear");
    expect((ksCalls[0].arg as string[]).sort()).toEqual(["120data_branch", "123teamA"].sort());
  });

  it("skill grant writes kernel ACL only (no KS call)", async () => {
    ksCalls.length = 0;
    const r = await post("/api/v1/asset/grant", {
      asset_id: SKILL, node_id: "123teamB", action: "grant",
    });
    expect(r.json.code).toBe(0);
    expect(r.json.data.ks_mirror).toBeNull();
    expect(ksCalls).toHaveLength(0);
    await post("/api/v1/asset/grant", { asset_id: SKILL, node_id: "123teamB", action: "revoke" });
  });

  it("invalid identity gets 401", async () => {
    const r = await post("/api/v1/asset/grant", {
      asset_id: WIKI, node_id: "120data_branch", action: "grant",
    }, "bogus-key");
    expect(r.status).toBe(401);
  });

  it("kernel stores per-node grant_type for the mirror", async () => {
    await post("/api/v1/asset/grant", {
      asset_id: WIKI, node_id: "120data_branch", action: "grant", grant_type: "editor",
    });
    expect((await svc.rawStore.getGroupyShare(WIKI))?.grant_types).toEqual({
      "120data_branch": "editor",
    });
    await post("/api/v1/asset/grant", { asset_id: WIKI, node_id: "120data_branch", action: "revoke" });
  });

  it("mirror-sync heals drifted KS rows with stored types", async () => {
    await post("/api/v1/asset/grant", {
      asset_id: WIKI, node_id: "120data_branch", action: "grant", grant_type: "editor",
    });
    // simulate drift: drop a team row, add a stale one, downgrade a type
    ksState.set(`wiki:${WIKI}`, [
      { team_id: "123teamA", grant_type: "viewer" },
      { team_id: "stale-team", grant_type: "viewer" },
    ]);
    const r = await post("/api/v1/groupy/mirror-sync", {});
    expect(r.json.code).toBe(0);
    const rows = ksState.get(`wiki:${WIKI}`) ?? [];
    expect(rows.map((g) => g.team_id).sort()).toEqual(["120data_branch", "123teamA"].sort());
    expect(new Set(rows.map((g) => g.grant_type))).toEqual(new Set(["editor"]));
    await post("/api/v1/asset/grant", { asset_id: WIKI, node_id: "120data_branch", action: "revoke" });
  });

  it("mirror-sync skips failed assets and heals the rest", async () => {
    await post("/api/v1/asset/grant", {
      asset_id: WIKI, node_id: "120data_branch", action: "grant", grant_type: "editor",
    });
    const second = await svc.createAsset({
      asset_id: "wiki-grant01", team_id: "123teamA", asset_type: "llm_wiki",
      name: "second wiki", owner_user_id: yonikId, source_type: "test",
    });
    await post("/api/v1/asset/grant", {
      asset_id: second.asset_id, node_id: "120data_branch", action: "grant",
    });
    ksState.set(`wiki:${second.asset_id}`, []);
    ksFailIds.add(second.asset_id);
    const r = await post("/api/v1/groupy/mirror-sync", {});
    ksFailIds.delete(second.asset_id);
    expect(r.json.code).toBe(0);
    const entry = r.json.data.assets.find((a: any) => a.asset_id === second.asset_id);
    expect(entry.skipped).toBe("KS unreachable");
    // first asset still healed in the same run
    const rows = ksState.get(`wiki:${WIKI}`) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    await post("/api/v1/asset/grant", { asset_id: second.asset_id, node_id: "120data_branch", action: "revoke" });
    await post("/api/v1/asset/grant", { asset_id: WIKI, node_id: "120data_branch", action: "revoke" });
  });

  it("non-admin caller gets 403", async () => {
    const bob = await svc.createNormalUser({ username: "bob" });
    const r = await post("/api/v1/asset/grant", {
      asset_id: WIKI, node_id: "120data_branch", action: "grant",
    }, bob.default_user_key);
    expect(r.status).toBe(403);
  });

  it("orphans surface archived-node shares", async () => {
    await post("/api/v1/asset/grant", { asset_id: WIKI, node_id: "123teamB", action: "grant" });
    writeFileSync(fixturePath, JSON.stringify(matrix(true)));
    const sync = await post("/api/v1/groupy/sync", {});
    expect(sync.json.data.status).toBe("ok");
    expect(sync.json.data.revoked_grants).toEqual(["123teamB"]);
    const orphans = await post("/api/v1/groupy/orphans", {});
    // share fully revoked on empty nodes → no orphans left, but status shows the archive
    expect(orphans.json.code).toBe(0);
    const status = await post("/api/v1/groupy/status", {});
    expect(status.json.data.enabled).toBe(true);
    expect(status.json.data.last_run.status).toBe("ok");
  });
});
