/**
 * customer-integration.test.ts — Panel -> KS seams with fully fake data.
 *
 * Real registerKnowledgeWikiRoutes + real header/gate helpers; Meta kernel and
 * KS are in-memory fakes. Proves what customers hit through Panel: header
 * validation, team gates, asset registration on create, KS error mapping
 * (404 passthrough, KS down -> 502, never a hang), and userKey/instance
 * forwarding into the knowledge client factory.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";

import { InstanceRegistry } from "../src/panel/config/instance-registry.js";
import { registerKnowledgeWikiRoutes } from "../src/panel/http/routes/knowledge/wiki-routes.js";
import { DomainError } from "../src/panel/domain/errors.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";

const INST = "test-cust-1";
const USER_KEY = "fake-user-key";
const USER_ID = "u-fake-1";
const TEAM = "team-fake-1";
const MARKER = "panelfakemarker";

const FAKE_WIKI_BASE = {
  wiki_id: "wiki-fake0001",
  team_id: TEAM,
  name: "fake-wiki",
  service_url: null,
  summary: null,
  status: "ready",
  sync_error: null,
  version: "1",
  owner_user_id: USER_ID,
  page_count: 1,
  last_sync_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

// Fake KS data + spies
const assets = new Map<string, unknown>();
const factorySeen: Array<{ instanceId: string; userKey: string }> = [];
const ksSeen: Array<{ op: string; args: unknown }> = [];
let ksDown = false;
let isMember = true;

const fakeKs = {
  async wikiCreate(teamId: string, name: string) {
    ksSeen.push({ op: "wikiCreate", args: { teamId, name } });
    if (ksDown) throw new Error("ks down");
    return { ...FAKE_WIKI_BASE, name };
  },
  async wikiGet(wikiId: string) {
    ksSeen.push({ op: "wikiGet", args: { wikiId } });
    if (ksDown) throw new Error("ks down");
    if (wikiId !== FAKE_WIKI_BASE.wiki_id)
      throw new DomainError("wiki not found", "NOT_FOUND", 404);
    return { ...FAKE_WIKI_BASE };
  },
  async wikiList() {
    ksSeen.push({ op: "wikiList", args: {} });
    if (ksDown) throw new Error("ks down");
    return { items: [{ ...FAKE_WIKI_BASE }], total: 1 };
  },
  async wikiRawLs() {
    ksSeen.push({ op: "wikiRawLs", args: {} });
    return { items: [{ filename: "notes.md" }] };
  },
  async wikiRawRead() {
    ksSeen.push({ op: "wikiRawRead", args: {} });
    return { items: [{ filename: "notes.md", content: `guide ${MARKER}` }] };
  },
  async wikiRawWrite() {
    ksSeen.push({ op: "wikiRawWrite", args: {} });
    return { ok: true };
  },
  async wikiSearch() {
    ksSeen.push({ op: "wikiSearch", args: {} });
    if (ksDown) throw new Error("ks down");
    return {
      results: [{ ref: "notes", snippet: MARKER }],
      links: [],
      count: 1,
    };
  },
  async wikiIngest() {
    ksSeen.push({ op: "wikiIngest", args: {} });
    if (ksDown) throw new Error("ks down");
    return { wiki_id: FAKE_WIKI_BASE.wiki_id, status: "processing" };
  },
  async wikiDelete(ids: string[]) {
    ksSeen.push({ op: "wikiDelete", args: { ids } });
    return { deleted_ids: ids, failed: [] };
  },
};

const metaKernel = {
  async invoke(action: string, body: Record<string, unknown>) {
    const ok = (data: unknown) => ({
      code: 0,
      message: "ok",
      request_id: "t",
      data,
    });
    const empty = (code: number, message: string) => ({
      code,
      message,
      request_id: "t",
      data: null,
    });
    switch (action) {
      case "auth/verify":
        return body.user_key === USER_KEY
          ? ok({ valid: true, user: { user_id: USER_ID } })
          : ok({ valid: false });
      case "team-member/get":
        return isMember
          ? ok({ team_id: TEAM, user_id: USER_ID })
          : empty(404, "no");
      case "acl/check":
        return ok({ allowed: true });
      case "asset/get": {
        const a = assets.get(body.asset_id as string);
        return a ? ok(a) : empty(404, "no");
      }
      case "asset/create": {
        const a = {
          asset_id: body.asset_id,
          team_id: body.team_id,
          asset_type: body.asset_type,
          name: body.name,
          owner_user_id: body.owner_user_id,
          visibility: "team",
          status: "active",
        };
        assets.set(body.asset_id as string, a);
        return ok(a);
      }
      case "asset/delete":
        for (const id of (body.asset_ids as string[]) ?? []) assets.delete(id);
        return ok({ ok: true });
      default:
        return empty(400, `unsupported: ${action}`);
    }
  },
};

const nullLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
} as unknown;

let base = "";
let server: Server;

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": INST,
      "x-tdai-user-key": USER_KEY,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as { code: number; message: string; data: any },
  };
}

beforeAll(async () => {
  const deps = {
    config: {},
    logger: nullLogger,
    instanceRegistry: new InstanceRegistry([
      {
        instance_id: INST,
        name: "t",
        gateway_endpoint: "http://127.0.0.1:9",
        api_key: "k",
      },
    ]),
    metaKernel,
    knowledgeClientFactory: (instanceId: string, userKey: string) => {
      factorySeen.push({ instanceId, userKey });
      return fakeKs;
    },
    ingestProgressStore: { get: () => null },
  } as unknown as PanelDeps;
  const app = new Hono();
  const api = new Hono();
  registerKnowledgeWikiRoutes(api, deps);
  app.route("/api/v1", api);
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("headers + validation (no KS hit)", () => {
  it("missing instance header -> 401 MISSING_INSTANCE_ID", async () => {
    const res = await fetch(`${base}/api/v1/knowledge/wiki/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-user-key": USER_KEY,
      },
      body: JSON.stringify({ team_id: TEAM }),
    });
    expect(res.status).toBe(401);
  });

  it("missing user key -> 401 MISSING_USER_KEY", async () => {
    const res = await fetch(`${base}/api/v1/knowledge/wiki/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": INST,
      },
      body: JSON.stringify({ team_id: TEAM }),
    });
    expect(res.status).toBe(401);
  });

  it("create without team_id -> 400, KS untouched", async () => {
    ksSeen.length = 0;
    const r = await post("/api/v1/knowledge/wiki/create", { name: "x" });
    expect(r.json.code).toBe(400);
    expect(ksSeen).toHaveLength(0);
  });

  it("bad user key -> 401 INVALID_USER_KEY", async () => {
    const r = await post(
      "/api/v1/knowledge/wiki/create",
      { team_id: TEAM, name: "x" },
      { "x-tdai-user-key": "bogus" },
    );
    expect(r.json.code).toBe(401);
  });

  it("non-member -> 403", async () => {
    isMember = false;
    try {
      const r = await post("/api/v1/knowledge/wiki/create", {
        team_id: TEAM,
        name: "x",
      });
      expect(r.json.code).toBe(403);
    } finally {
      isMember = true;
    }
  });
});

describe("customer wiki flow through Panel (fake KS)", () => {
  it("create registers meta asset + forwards identity to KS factory", async () => {
    factorySeen.length = 0;
    ksSeen.length = 0;
    const r = await post("/api/v1/knowledge/wiki/create", {
      team_id: TEAM,
      name: "fake-wiki",
    });
    expect(r.json.code).toBe(0);
    expect(r.json.data.wiki_id).toBe("wiki-fake0001");
    expect(assets.get("wiki-fake0001")).toMatchObject({
      team_id: TEAM,
      asset_type: "llm_wiki",
    });
    expect(factorySeen[0]).toEqual({ instanceId: INST, userKey: USER_KEY });
    expect(ksSeen[0]).toEqual({
      op: "wikiCreate",
      args: { teamId: TEAM, name: "fake-wiki" },
    });
  });

  it("get + search round-trip fake content", async () => {
    const g = await post("/api/v1/knowledge/wiki/get", {
      wiki_id: "wiki-fake0001",
    });
    expect(g.json.code).toBe(0);
    expect(g.json.data.name).toBe("fake-wiki");
    const s = await post("/api/v1/knowledge/wiki/search", {
      wiki_id: "wiki-fake0001",
      query: MARKER,
    });
    expect(s.json.code).toBe(0);
    expect(JSON.stringify(s.json.data)).toContain(MARKER);
  });

  it("get missing wiki -> 404 (KS error mapped, not 500)", async () => {
    const g = await post("/api/v1/knowledge/wiki/get", {
      wiki_id: "wiki-nope0001",
    });
    expect(g.json.code).toBe(404);
  });

  it("KS down -> 502 UPSTREAM_ERROR (never a hang)", async () => {
    ksDown = true;
    try {
      const g = await post("/api/v1/knowledge/wiki/get", {
        wiki_id: "wiki-fake0001",
      });
      expect(g.json.code).toBe(502);
    } finally {
      ksDown = false;
    }
  });

  it("ingest on wiki with sources -> KS ingest called", async () => {
    ksSeen.length = 0;
    const r = await post("/api/v1/knowledge/wiki/ingest", {
      wiki_id: "wiki-fake0001",
    });
    expect(r.json.code).toBe(0);
    expect(ksSeen.map((s) => s.op)).toContain("wikiIngest");
  });
});
