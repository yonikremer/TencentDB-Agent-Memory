/**
 * customer-codegraph.test.ts — Panel code-graph routes with fake KS + Meta.
 *
 * Covers the in-flight owner path (no meta asset yet), register-meta gating
 * (409 not-ready, 403 owner mismatch), sync passthrough, query shape,
 * delete cascade, and KS-down mapping.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";

import { InstanceRegistry } from "../src/panel/config/instance-registry.js";
import { registerKnowledgeCodeGraphRoutes } from "../src/panel/http/routes/knowledge/code-graph-routes.js";
import { DomainError } from "../src/panel/domain/errors.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";

const INST = "test-cg-1";
const USER_KEY = "fake-user-key";
const USER_ID = "u-fake-1";
const TEAM = "team-fake-1";

const FAKE_CG_BASE = {
  code_graph_id: "cg-fake0001",
  team_id: TEAM,
  repo_url: "https://example.com/r.git",
  repo_name: "r",
  branch: "main",
  status: "ready",
  owner_user_id: USER_ID,
  service_url: null,
  summary: null,
};

const assets = new Map<string, unknown>();
const ksSeen: string[] = [];
const taskRecords: unknown[] = [];
let ksStatus = "ready";
let ksDown = false;

const fakeKs = {
  async codeGraphCreate() {
    ksSeen.push("codeGraphCreate");
    if (ksDown) throw new Error("ks down");
    return { ...FAKE_CG_BASE, status: ksStatus };
  },
  async codeGraphList() {
    ksSeen.push("codeGraphList");
    return { items: [{ ...FAKE_CG_BASE }], total: 1 };
  },
  async codeGraphGet(id: string) {
    ksSeen.push("codeGraphGet");
    if (ksDown) throw new Error("ks down");
    if (id !== FAKE_CG_BASE.code_graph_id) throw new DomainError("cg not found", "NOT_FOUND", 404);
    return { ...FAKE_CG_BASE, status: ksStatus };
  },
  async codeGraphSync() {
    ksSeen.push("codeGraphSync");
    if (ksDown) throw new Error("ks down");
    return { code_graph_id: FAKE_CG_BASE.code_graph_id, status: "syncing" };
  },
  async codeGraphDelete(ids: string[]) {
    ksSeen.push("codeGraphDelete");
    return { deleted_ids: ids, failed: [] };
  },
  async codeGraphQuery() {
    ksSeen.push("codeGraphQuery");
    if (ksDown) throw new Error("ks down");
    return { text: "fake symbol here", isError: false };
  },
};

const metaKernel = {
  async invoke(action: string, body: Record<string, unknown>) {
    const ok = (data: unknown) => ({ code: 0, message: "ok", request_id: "t", data });
    const empty = (code: number, message: string) => ({ code, message, request_id: "t", data: null });
    switch (action) {
      case "auth/verify":
        return body.user_key === USER_KEY ? ok({ valid: true, user: { user_id: USER_ID } }) : ok({ valid: false });
      case "team-member/get":
        return ok({ team_id: TEAM, user_id: USER_ID });
      case "acl/check":
        return ok({ allowed: true });
      case "asset/get": {
        const a = assets.get(body.asset_id as string);
        return a ? ok(a) : empty(404, "no");
      }
      case "asset/create": {
        const a = { asset_id: body.asset_id, team_id: body.team_id, asset_type: body.asset_type };
        assets.set(body.asset_id as string, a);
        return ok(a);
      }
      case "asset/delete":
        for (const id of ((body.asset_ids as string[]) ?? [])) assets.delete(id);
        return ok({ ok: true });
      default:
        return empty(400, `unsupported: ${action}`);
    }
  },
};

const nullLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return nullLogger; } } as unknown;

let base = "";
let server: Server;

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-service-id": INST, "x-tdai-user-key": USER_KEY },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { code: number; message: string; data: any } };
}

beforeAll(async () => {
  const deps = {
    config: {},
    logger: nullLogger,
    instanceRegistry: new InstanceRegistry([{
      instance_id: INST, name: "t", gateway_endpoint: "http://127.0.0.1:9", api_key: "k",
    }]),
    metaKernel,
    knowledgeClientFactory: () => fakeKs,
    knowledgeTaskRegistry: { record: (r: unknown) => { taskRecords.push(r); } },
    ingestProgressStore: { get: () => null },
  } as unknown as PanelDeps;
  const app = new Hono();
  const api = new Hono();
  registerKnowledgeCodeGraphRoutes(api, deps);
  app.route("/api/v1", api);
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("code-graph create + in-flight owner read", () => {
  it("missing repo_url -> 400", async () => {
    const r = await post("/api/v1/knowledge/code-graph/create", { team_id: TEAM });
    expect(r.json.code).toBe(400);
  });

  it("create stashes owner task for S2S register", async () => {
    taskRecords.length = 0;
    const r = await post("/api/v1/knowledge/code-graph/create", { team_id: TEAM, repo_url: "https://example.com/r.git" });
    expect(r.json.code).toBe(0);
    expect(taskRecords).toHaveLength(1);
    expect(taskRecords[0]).toMatchObject({ knowledge_id: "cg-fake0001", owner_user_id: USER_ID });
  });

  it("get readable by KS owner before meta registered", async () => {
    const r = await post("/api/v1/knowledge/code-graph/get", { code_graph_id: "cg-fake0001" });
    expect(r.json.code).toBe(0);
  });
});

describe("register-meta gating", () => {
  it("not ready -> 409 CODE_GRAPH_NOT_READY", async () => {
    ksStatus = "processing";
    try {
      const r = await post("/api/v1/knowledge/code-graph/register-meta", { team_id: TEAM, code_graph_id: "cg-fake0001" });
      expect(r.json.code).toBe(409);
    } finally {
      ksStatus = "ready";
    }
  });

  it("ready -> registers meta asset", async () => {
    assets.clear();
    const r = await post("/api/v1/knowledge/code-graph/register-meta", { team_id: TEAM, code_graph_id: "cg-fake0001" });
    expect(r.json.code).toBe(0);
    expect(r.json.data.registered).toBe(true);
    expect(assets.get("cg-fake0001")).toMatchObject({ asset_type: "code_graph" });
  });
});

describe("sync / query / delete / failure mapping", () => {
  it("sync passes through to KS", async () => {
    ksSeen.length = 0;
    const r = await post("/api/v1/knowledge/code-graph/sync", { code_graph_id: "cg-fake0001" });
    expect(r.json.code).toBe(0);
    expect(ksSeen).toContain("codeGraphSync");
  });

  it("search returns KS text block", async () => {
    const r = await post("/api/v1/knowledge/code-graph/search", { code_graph_id: "cg-fake0001", query: "auth" });
    expect(r.json.code).toBe(0);
    expect(JSON.stringify(r.json.data)).toContain("fake symbol");
  });

  it("delete cascades meta asset", async () => {
    const r = await post("/api/v1/knowledge/code-graph/delete", { code_graph_ids: ["cg-fake0001"] });
    expect(r.json.code).toBe(0);
    expect(assets.has("cg-fake0001")).toBe(false);
  });

  it("KS down on registered asset -> 502 (unregistered masks as 404 via owner fallback)", async () => {
    await post("/api/v1/knowledge/code-graph/register-meta", { team_id: TEAM, code_graph_id: "cg-fake0001" });
    ksDown = true;
    try {
      const r = await post("/api/v1/knowledge/code-graph/get", { code_graph_id: "cg-fake0001" });
      expect(r.json.code).toBe(502);
    } finally {
      ksDown = false;
    }
  });
});
