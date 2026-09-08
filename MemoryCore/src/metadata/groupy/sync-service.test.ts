/**
 * Org-hierarchy-sync P1 — sync-service tests (TDD).
 * PLAN.md P1 acceptance 1-4: fixture run, idempotent re-run, move, archive.
 * Plus failure/retries and the team-create squat guard.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import { GroupyClient, type GroupyNodeData } from "./groupy-client.js";
import { runGroupySync } from "./sync-service.js";

class StubClient extends GroupyClient {
  constructor(private readonly nodes: Map<string, GroupyNodeData>) { super(); }
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

function matrixV1(): Map<string, GroupyNodeData> {
  return new Map([
    node("product_x", [["123teamA", "org"], ["123teamB", "org"]]),
    node("120data_branch", [["123teamA", "org"], ["999head", "user"]]),
    node("123teamA", [["123yonik", "user"], ["124alice", "user"]]),
    node("123teamB", [["124alice", "user"]]),
  ]);
}

const ROOTS = ["product_x", "120data_branch"];

async function setup() {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  const service = new MetadataService(store);
  const client = new StubClient(matrixV1());
  return { store, service, client };
}

async function memberIds(store: SqliteMetadataStore, teamId: string): Promise<string[]> {
  const page = await store.listTeamMembers(teamId, { limit: 200, offset: 0 });
  return page.items.map((m) => m.user_id).sort();
}

async function usernameOf(store: SqliteMetadataStore, userId: string): Promise<string> {
  return (await store.getUserById(userId))!.username;
}

describe("runGroupySync", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { ctx = await setup(); });

  it("fixture run creates teams + closure memberships", async () => {
    const { store, service, client } = ctx;
    const summary = await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    expect(summary.status).toBe("ok");
    expect(summary.teams_created).toBe(4);
    expect(summary.users_created).toBe(4); // yonik, alice, head + groupy-sync owner
    // team ids verbatim, names from displayName
    expect((await store.getTeamById("123teamA"))?.name).toBe("Display 123teamA");
    // alice: two chains → 4 teams
    const aliceTeams = ["product_x", "120data_branch", "123teamA", "123teamB"];
    for (const t of aliceTeams) {
      const ids = await memberIds(store, t);
      const names = await Promise.all(ids.map((u) => usernameOf(store, u)));
      expect(names).toContain("124alice");
    }
    // yonik: single chain → 3 teams, not in teamB
    const teamBMembers = await memberIds(store, "123teamB");
    const teamBNames = await Promise.all(teamBMembers.map((u) => usernameOf(store, u)));
    expect(teamBNames).not.toContain("123yonik");
    // head is member of branch team
    const branchNames = await Promise.all(
      (await memberIds(store, "120data_branch")).map((u) => usernameOf(store, u)));
    expect(branchNames).toContain("999head");
    // run persisted
    expect((await store.getLatestGroupyRun())?.status).toBe("ok");
  });

  it("re-run touches no rows (updated_at stable)", async () => {
    const { store, service, client } = ctx;
    await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    const nodeBefore = (await store.listGroupyNodes(true)).map((n) => `${n.node_id}=${n.updated_at}`).sort();
    const teamBefore = (await store.getTeamById("123teamA"))!.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    const nodeAfter = (await store.listGroupyNodes(true)).map((n) => `${n.node_id}=${n.updated_at}`).sort();
    expect(nodeAfter).toEqual(nodeBefore);
    expect((await store.getTeamById("123teamA"))!.updated_at).toBe(teamBefore);
  });

  it("re-run is idempotent (zero changes)", async () => {
    const { service, client } = ctx;
    await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    const second = await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    expect(second.status).toBe("ok");
    expect(second.teams_created).toBe(0);
    expect(second.teams_archived).toBe(0);
    expect(second.members_added).toBe(0);
    expect(second.members_removed).toBe(0);
    expect(second.users_created).toBe(0);
  });

  it("moved person flips only moved rows", async () => {
    const { store, service, client } = ctx;
    await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    // alice leaves teamA (stays in teamB)
    const v2 = matrixV1();
    v2.set(node("123teamA", [["123yonik", "user"]])[0], node("123teamA", [["123yonik", "user"]])[1]);
    client.setNodes(v2);
    const summary = await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    // alice left teamA → out of teamA AND the branch chain above it
    expect(summary.members_removed).toBe(2);
    expect(summary.members_added).toBe(0);
    const alice = (await store.listUsers({ limit: 50, offset: 0 }, { username: "124alice" })).items[0];
    expect((await store.getTeamMember("123teamA", alice.user_id))?.status).toBe("removed");
    expect((await store.getTeamMember("120data_branch", alice.user_id))?.status).toBe("removed");
    expect((await store.getTeamMember("123teamB", alice.user_id))?.status).toBe("active");
    expect((await store.getTeamMember("product_x", alice.user_id))?.status).toBe("active");
  });

  it("deleted node archives team, clears members, keeps content", async () => {
    const { store, service, client } = ctx;
    await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    const owner = (await store.listUsers({ limit: 50, offset: 0 }, { username: "124alice" })).items[0];
    await service.createAsset({
      asset_id: "ast-1", team_id: "123teamB", asset_type: "skill",
      name: "s", owner_user_id: owner.user_id, source_type: "test",
    });
    // drop teamB from the graph entirely
    const v2 = matrixV1();
    v2.delete("123teamB");
    const px = v2.get("product_x")!;
    v2.set("product_x", { ...px, members: px.members.filter((m) => m.id !== "123teamB") });
    client.setNodes(v2);
    const summary = await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    expect(summary.teams_archived).toBe(1);
    expect(summary.archived_nodes).toEqual(["123teamB"]);
    expect((await store.getTeamById("123teamB"))?.status).toBe("archived");
    expect((await memberIds(store, "123teamB"))).toEqual([]);
    expect(await store.getAssetById("ast-1")).not.toBeNull();
  });

  it("fetch failure retries then records a failed run, keeping last-good", async () => {
    const { store, service, client } = ctx;
    await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    const sleeps: number[] = [];
    client.setNodes(new Map()); // every fetch throws node_not_found
    const summary = await runGroupySync({
      client, roots: ROOTS, service,
      retryDelaysMs: [0, 0, 0],
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(summary.status).toBe("failed");
    expect(sleeps).toHaveLength(3);
    expect(summary.error).toMatch("node_not_found");
    expect((await store.getLatestGroupyRun())?.status).toBe("failed");
    // last-good state untouched
    expect((await store.getTeamById("123teamA"))?.status).toBe("active");
  });

  it("team/create rejects a live groupy node id (squat guard)", async () => {
    const { service, client } = ctx;
    await runGroupySync({ client, roots: ROOTS, service, retryDelaysMs: [] });
    const admin = await service.createNormalUser({ username: "admin-u" });
    const adminCtx = { token: "", userId: admin.user_id, isAdmin: false, isSystemAdmin: true };
    await expect(service.createTeamForCaller(
      { team_id: "123teamA", name: "squat", owner_user_id: admin.user_id },
      adminCtx,
    )).rejects.toThrowError(expect.objectContaining({ code: "groupy_managed_id" }));
    // free id still works
    const team = await service.createTeamForCaller(
      { team_id: "manual-team", name: "Manual", owner_user_id: admin.user_id },
      adminCtx,
    );
    expect(team.team_id).toBe("manual-team");
  });
});
