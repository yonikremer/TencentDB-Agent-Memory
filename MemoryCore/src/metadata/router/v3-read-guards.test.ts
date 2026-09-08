/**
 * Identity review — read-path authorization guards.
 *
 * Write paths go through *ForCaller, but reads historically ignored ctx.
 * These tests pin the closed IDOR gaps: cross-user queries are denied and
 * cross-team reads return 404 (never 403) so existence cannot be probed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteMetadataStore } from "../store/sqlite-adapter.js";
import { MetadataService } from "../service/metadata-service.js";
import { handleV3MetaRoute } from "./v3-meta-router.js";
import type { V3AuthContext } from "./auth.js";

const silentLogger: any = { debug() {}, info() {}, warn() {}, error() {} };

interface Fixture {
  svc: MetadataService;
  keys: Record<string, string>;
  ids: Record<string, string>;
}

async function setup(): Promise<Fixture> {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  const svc = new MetadataService(store);
  const keys: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const u of ["alice", "bob"]) {
    const r = await svc.createNormalUserWithKey({
      username: u,
      user_key: `key-${u}-001`,
    });
    ids[u] = r.user_id;
    keys[u] = r.default_user_key;
  }
  const adminCtx: V3AuthContext = {
    token: "",
    userId: ids.alice,
    isAdmin: false,
    isSystemAdmin: true,
  };
  const team = await svc.createTeamForCaller(
    { name: "teamA", owner_user_id: ids.alice },
    adminCtx,
  );
  ids.teamA = team.team_id;
  // NOTE: createTeamForCaller enrolls the owner as an admin member; no separate add needed.
  await svc.createAssetForCaller(
    {
      asset_id: "asset-1",
      team_id: team.team_id,
      asset_type: "skill",
      name: "a1",
      owner_user_id: ids.alice,
      source_type: "test",
      visibility: "team",
    },
    { token: "", userId: ids.alice, isAdmin: false, isSystemAdmin: false },
  );
  return { svc, keys, ids };
}

async function callRoute(
  svc: MetadataService,
  path: string,
  body: unknown,
  userKey: string,
): Promise<{ status: number; payload: any }> {
  const req: any = {
    headers: { "x-tdai-service-id": "test", "x-tdai-user-key": userKey },
  };
  let status = 0;
  let payload: any = null;
  await handleV3MetaRoute(
    req,
    {} as any,
    path,
    "POST",
    async () => body,
    (_res: any, s: number, b: unknown) => {
      status = s;
      payload = b;
    },
    { getMetadataService: () => svc, logger: silentLogger },
  );
  return { status, payload };
}

describe("v3 read guards", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await setup();
  });

  it("team/list scoped to caller: bob cannot list alice teams", async () => {
    const r = await callRoute(
      fx.svc,
      "/v3/meta/team/list",
      { user_id: fx.ids.alice },
      fx.keys.bob,
    );
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.payload)).toMatch(/permission_denied/);
  });

  it("team/get hidden from non-members (404, no oracle)", async () => {
    const r = await callRoute(
      fx.svc,
      "/v3/meta/team/get",
      { team_id: fx.ids.teamA },
      fx.keys.bob,
    );
    expect(r.status).toBe(404);
  });

  it("team/get works for members", async () => {
    const r = await callRoute(
      fx.svc,
      "/v3/meta/team/get",
      { team_id: fx.ids.teamA },
      fx.keys.alice,
    );
    expect(r.status).toBe(200);
  });

  it("asset/get hidden from non-members (404, no oracle)", async () => {
    const r = await callRoute(
      fx.svc,
      "/v3/meta/asset/get",
      { asset_id: "asset-1" },
      fx.keys.bob,
    );
    expect(r.status).toBe(404);
  });

  it("user/get scoped to caller", async () => {
    const r = await callRoute(
      fx.svc,
      "/v3/meta/user/get",
      { user_id: fx.ids.alice },
      fx.keys.bob,
    );
    expect(r.status).toBe(403);
  });
});
