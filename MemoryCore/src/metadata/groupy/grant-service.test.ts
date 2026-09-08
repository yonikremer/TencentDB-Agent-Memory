/**
 * Org-hierarchy-sync P2 — grant expansion tests (TDD). PLAN.md P2 acceptance:
 * expansion (users+agents, home preserved), kernel grant path, agent-context
 * check, archived-node revoke.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import { GroupyClient, type GroupyNodeData } from "./groupy-client.js";
import { runGroupySync } from "./sync-service.js";
import { computeMembershipClosure } from "./closure.js";
import {
  applyAssetShare,
  expandShareTargets,
  recomputeGroupyShares,
  buildGraphFromStore,
} from "./grant-service.js";
import type { V3AuthContext } from "../router/auth.js";

class StubClient extends GroupyClient {
  constructor(private nodes: Map<string, GroupyNodeData>) { super(); }
  async fetchNode(id: string): Promise<GroupyNodeData> {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`node_not_found: ${id}`);
    return n;
  }
  setNodes(nodes: Map<string, GroupyNodeData>): void { this.nodes = nodes; }
}

function node(id: string, members: Array<[string, "user" | "org"]>): [string, GroupyNodeData] {
  return [id, {
    id, name: `name-${id}`, display_name: `Display ${id}`,
    members: members.map(([mid, kind]) => ({ id: mid, kind })),
  }];
}

function matrix(): Map<string, GroupyNodeData> {
  return new Map([
    node("product_x", [["123teamA", "org"], ["123teamB", "org"]]),
    node("120data_branch", [["123teamA", "org"], ["999head", "user"]]),
    node("123teamA", [["123yonik", "user"], ["124alice", "user"]]),
    node("123teamB", [["124alice", "user"]]),
  ]);
}

const ROOTS = ["product_x", "120data_branch"];

interface Ctx {
  store: SqliteMetadataStore;
  service: MetadataService;
  client: StubClient;
  adminCtx: V3AuthContext;
  ids: Record<string, string>;
}

async function setup(): Promise<Ctx> {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  const service = new MetadataService(store);
  const client = new StubClient(matrix());
  await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
  const admin = await service.createNormalUser({ username: "admin-u" });
  const adminCtx: V3AuthContext = { token: "", userId: admin.user_id, isAdmin: false, isSystemAdmin: true };
  const userId = async (username: string): Promise<string> =>
    (await store.listUsers({ limit: 5, offset: 0 }, { username })).items[0].user_id;
  const ids: Record<string, string> = {};
  for (const u of ["123yonik", "124alice", "999head"]) ids[u] = await userId(u);
  // agents: alice in teamA, head in branch, yonik in teamB
  ids.aliceAgent = (await service.createAgent({ team_id: "123teamA", owner_user_id: ids["124alice"], name: "a-alice" })).agent_id;
  ids.headAgent = (await service.createAgent({ team_id: "120data_branch", owner_user_id: ids["999head"], name: "a-head" })).agent_id;
  ids.yonikAgent = (await service.createAgent({ team_id: "123teamB", owner_user_id: ids["123yonik"], name: "a-yonik" })).agent_id;
  // skill homed in teamA, owned by yonik
  await service.createAsset({
    asset_id: "ast-skill", team_id: "123teamA", asset_type: "skill",
    name: "shared-skill", owner_user_id: ids["123yonik"], source_type: "test",
  });
  return { store, service, client, adminCtx, ids };
}

async function aclSubjects(store: SqliteMetadataStore, assetId: string): Promise<string[]> {
  const page = await store.listAclByAsset(assetId, { limit: 100, offset: 0 });
  return page.items.map((r) => `${r.subject_type}:${r.subject_id}:${r.permission}`).sort();
}

describe("expandShareTargets", () => {
  it("unions subtree users + their agents with home team preserved", async () => {
    const ctx = await setup();
    const graph = await buildGraphFromStore(ctx.service);
    const closure = computeMembershipClosure(graph);
    const out = await expandShareTargets(ctx.service, closure, new Set(["120data_branch", "123teamA"]), "123teamA");
    const usernames = await Promise.all([...out.userIds].map(async (u) => (await ctx.store.getUserById(u))!.username));
    expect(usernames.sort()).toEqual(["123yonik", "124alice", "999head"].sort());
    expect([...out.agentIds].sort()).toEqual([ctx.ids.aliceAgent, ctx.ids.headAgent, ctx.ids.yonikAgent].sort());
  });
});

describe("applyAssetShare", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setup(); });

  it("grant flips to restricted with user+agent rows, home preserved", async () => {
    const res = await applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "120data_branch", action: "grant", ctx: ctx.adminCtx,
    });
    expect(res.visibility).toBe("restricted");
    expect(res.nodes).toEqual(["120data_branch"]);
    const subjects = await aclSubjects(ctx.store, "ast-skill");
    // owner + home members + closure users as user rows…
    for (const u of [ctx.ids["123yonik"], ctx.ids["124alice"], ctx.ids["999head"]]) {
      expect(subjects).toContain(`user:${u}:read`);
    }
    // …and every expansion user's agents as agent rows
    for (const a of [ctx.ids.aliceAgent, ctx.ids.headAgent, ctx.ids.yonikAgent]) {
      expect(subjects).toContain(`agent:${a}:read`);
      expect(subjects).toContain(`agent:${a}:use`);
    }
  });

  it("agent-context permission check passes for granted cross-team user", async () => {
    await applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "120data_branch", action: "grant", ctx: ctx.adminCtx,
    });
    // head is NOT a home-team (teamA) member — pure ACL whitelist must allow
    const perm = await ctx.service.checkAssetPermission({
      user_id: ctx.ids["999head"], asset_id: "ast-skill", action: "read",
    });
    expect(perm.allowed).toBe(true);
    const agentPerm = await ctx.service.checkAssetPermission({
      user_id: ctx.ids["124alice"], asset_id: "ast-skill",
      action: "use", agent_id: ctx.ids.aliceAgent,
    });
    expect(agentPerm.allowed).toBe(true);
    // outsider with no grant still denied
    const stranger = await ctx.service.createNormalUser({ username: "stranger" });
    const denied = await ctx.service.checkAssetPermission({
      user_id: stranger.user_id, asset_id: "ast-skill", action: "read",
    });
    expect(denied.allowed).toBe(false);
  });

  it("revoke drops granted rows and restores visibility", async () => {
    await applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "120data_branch", action: "grant", ctx: ctx.adminCtx,
    });
    const res = await applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "120data_branch", action: "revoke", ctx: ctx.adminCtx,
    });
    expect(res.visibility).toBe("team");
    expect(res.nodes).toEqual([]);
    const subjects = await aclSubjects(ctx.store, "ast-skill");
    expect(subjects.some((s) => s.includes(ctx.ids["999head"]))).toBe(false);
    expect(subjects.some((s) => s.includes(ctx.ids.headAgent))).toBe(false);
  });

  it("asset owner outside the home team is still included", async () => {
    const outsider = await ctx.service.createNormalUser({ username: "owner-out" });
    await ctx.service.createAsset({
      asset_id: "ast-out", team_id: "123teamA", asset_type: "skill",
      name: "o", owner_user_id: outsider.user_id, source_type: "test",
    });
    await applyAssetShare(ctx.service, {
      asset_id: "ast-out", node_id: "123teamB", action: "grant", ctx: ctx.adminCtx,
    });
    const subjects = await aclSubjects(ctx.store, "ast-out");
    expect(subjects).toContain(`user:${outsider.user_id}:read`);
  });

  it("grant persists grant_type per node and caps subtree fan-out", async () => {
    const res = await applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "120data_branch", action: "grant",
      grant_type: "editor", ctx: ctx.adminCtx,
    });
    expect(res.grant_type).toBe("editor");
    expect((await ctx.store.getGroupyShare("ast-skill"))?.grant_types).toEqual({
      "120data_branch": "editor",
    });
    await expect(applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "120data_branch", action: "grant", ctx: ctx.adminCtx,
      maxTeams: 1,
    })).rejects.toThrowError(expect.objectContaining({ code: "groupy_subtree_too_large" }));
    await expect(applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "120data_branch", action: "grant",
      grant_type: "super", ctx: ctx.adminCtx,
    })).rejects.toThrowError(expect.objectContaining({ code: "invalid_grant_type" }));
  });

  it("agent rows do not impersonate: stranger with another agent_id is denied", async () => {
    await applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "120data_branch", action: "grant", ctx: ctx.adminCtx,
    });
    const stranger = await ctx.service.createNormalUser({ username: "stranger2" });
    const denied = await ctx.service.checkAssetPermission({
      user_id: stranger.user_id, asset_id: "ast-skill",
      action: "read", agent_id: ctx.ids.aliceAgent,
    });
    expect(denied.allowed).toBe(false);
  });

  it("team_role rows survive; removed members and archived children stay out", async () => {
    // manual team_role grant + a removed member + archived child setup
    await ctx.service.grantAcl({
      asset_id: "ast-skill", subject_type: "team_role", subject_id: "member",
      permission: "read", granted_by: ctx.adminCtx.userId!,
    });
    const alice = (await ctx.store.listUsers({ limit: 5, offset: 0 }, { username: "124alice" })).items[0];
    await ctx.store.addTeamMember({ team_id: "123teamA", user_id: alice.user_id, role: "member", status: "removed" });
    // archive teamB, then grant the parent: teamB must not expand
    const v2 = matrix();
    v2.delete("123teamB");
    const px = v2.get("product_x")!;
    v2.set("product_x", { ...px, members: px.members.filter((m) => m.id !== "123teamB") });
    ctx.client.setNodes(v2);
    await runGroupySync({ client: ctx.client, roots: ROOTS, service: ctx.service, retryDelaysMs: [] });
    const res = await applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "product_x", action: "grant", ctx: ctx.adminCtx,
    });
    // teamB archived → excluded from subtree (branch was never under product_x)
    expect(res.teams.sort()).toEqual(["123teamA", "product_x"].sort());
    const subjects = await aclSubjects(ctx.store, "ast-skill");
    expect(subjects).toContain("team_role:member:read");
    const aliceRows = subjects.filter((s) => s.includes(alice.user_id));
    expect(aliceRows.length).toBeGreaterThan(0); // alice active via teamA still
  });

  it("non-owner non-admin caller is rejected", async () => {
    const stranger = await ctx.service.createNormalUser({ username: "stranger" });
    const strangerCtx: V3AuthContext = { token: "", userId: stranger.user_id, isAdmin: false, isSystemAdmin: false };
    await expect(applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "120data_branch", action: "grant", ctx: strangerCtx,
    })).rejects.toThrowError(expect.objectContaining({ code: "permission_denied" }));
  });

  it("asset owner can grant without admin", async () => {
    const ownerCtx: V3AuthContext = { token: "", userId: ctx.ids["123yonik"], isAdmin: false, isSystemAdmin: false };
    const res = await applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "123teamB", action: "grant", ctx: ownerCtx,
    });
    expect(res.visibility).toBe("restricted");
  });

  it("unknown node fails; archived node refuses new grants", async () => {
    await expect(applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "nope", action: "grant", ctx: ctx.adminCtx,
    })).rejects.toThrowError(expect.objectContaining({ code: "groupy_node_not_found" }));
    // archive teamB then try granting to it
    const v2 = matrix();
    v2.delete("123teamB");
    const px = v2.get("product_x")!;
    v2.set("product_x", { ...px, members: px.members.filter((m) => m.id !== "123teamB") });
    ctx.client.setNodes(v2);
    await runGroupySync({ client: ctx.client, roots: ROOTS, service: ctx.service, retryDelaysMs: [] });
    await expect(applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "123teamB", action: "grant", ctx: ctx.adminCtx,
    })).rejects.toThrowError(expect.objectContaining({ code: "groupy_node_archived" }));
  });

  it("nightly recompute auto-revokes archived-node shares and heals drift", async () => {
    await applyAssetShare(ctx.service, {
      asset_id: "ast-skill", node_id: "123teamB", action: "grant", ctx: ctx.adminCtx,
    });
    // move head out of the branch in the fixture (drift) + drop teamB (archive)
    const v2 = matrix();
    v2.delete("123teamB");
    const px = v2.get("product_x")!;
    v2.set("product_x", { ...px, members: px.members.filter((m) => m.id !== "123teamB") });
    const br = v2.get("120data_branch")!;
    v2.set("120data_branch", { ...br, members: br.members.filter((m) => m.id !== "999head") });
    ctx.client.setNodes(v2);
    const summary = await runGroupySync({
      client: ctx.client, roots: ROOTS, service: ctx.service, retryDelaysMs: [],
      onMembershipApplied: (c) => recomputeGroupyShares({
        service: c.service, graph: c.graph, closure: c.closure, archivedNodes: c.archivedNodes,
      }),
    });
    expect(summary.revoked_grants).toEqual(["123teamB"]);
    // share fully revoked → visibility restored, head rows gone
    expect((await ctx.service.getAssetById("ast-skill"))?.visibility).toBe("team");
    const subjects = await aclSubjects(ctx.store, "ast-skill");
    expect(subjects.some((s) => s.includes(ctx.ids["999head"])) ||
      subjects.some((s) => s.includes(ctx.ids.headAgent))).toBe(false);
  });
});
