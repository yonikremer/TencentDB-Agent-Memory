/**
 * customer-misc.test.ts — remaining Panel routes with fakes.
 *
 * Skill transparent proxy (allowlist + forward), task list-with-agents
 * (N+1 aggregation shape), chat-memory team-assets/create. Fake Meta +
 * skill kernels; asserts gates, shapes, and error passthrough.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";

import { InstanceRegistry } from "../src/panel/config/instance-registry.js";
import { registerSkillProxyRoutes } from "../src/panel/http/routes/skill/proxy.js";
import { registerTaskRoutes } from "../src/panel/http/routes/task.js";
import { registerChatMemoryRoutes } from "../src/panel/http/routes/chat-memory.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";

const INST = "test-misc-1";
const USER_KEY = "fake-user-key";
const USER_ID = "u-fake-1";
const TEAM = "team-fake-1";
const AGENT = "agent-fake-1";

const skillSeen: Array<{ action: string; body: unknown }> = [];
const metaSeen: string[] = [];

const skillKernel = {
  async invoke(action: string, body: Record<string, unknown>) {
    skillSeen.push({ action, body });
    return {
      code: 0,
      message: "ok",
      request_id: "t",
      data: { items: [{ skill_id: "skl-fake1" }], action },
    };
  },
};

const metaKernel = {
  async invoke(action: string, body: Record<string, unknown>) {
    metaSeen.push(action);
    const ok = (data: unknown) => ({
      code: 0,
      message: "ok",
      request_id: "t",
      data,
    });
    switch (action) {
      case "auth/verify":
        return body.user_key === USER_KEY
          ? ok({ valid: true, user: { user_id: USER_ID } })
          : ok({ valid: false });
      case "team-member/get":
        return ok({ team_id: TEAM, user_id: USER_ID });
      case "acl/check":
        return ok({ allowed: true });
      case "asset/get":
        return (body.asset_id as string) === SEARCH_BLOCK
          ? ok({
              asset_id: SEARCH_BLOCK,
              name: "searchable",
              asset_type: "chat_memory",
              visibility: "team",
              status: "active",
              owner_user_id: USER_ID,
              team_id: TEAM,
              updated_at: "2026-01-01T00:00:00.000Z",
            })
          : { code: 404, message: "no", request_id: "t", data: null };
      case "task/list":
        return ok({ items: [{ task_id: "task-1", title: "t1" }], total: 1 });
      case "task-agent/list":
        return ok({ items: [{ agent_id: AGENT }] });
      case "asset/list":
        return ok({
          items: [
            {
              asset_id: "cm-1",
              name: "shared",
              asset_type: "chat_memory",
              visibility: "team",
              status: "active",
              owner_user_id: USER_ID,
              updated_at: "2026-01-01T00:00:00.000Z",
            },
            {
              asset_id: "cm-old",
              name: "archived",
              asset_type: "chat_memory",
              visibility: "team",
              status: "archived",
              owner_user_id: USER_ID,
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          total: 2,
        });
      case "asset/create":
        return ok({
          asset_id: "cm-new",
          name: body.name,
          asset_type: "chat_memory",
          visibility: body.visibility ?? "team",
          owner_user_id: USER_ID,
          updated_at: "2026-01-01T00:00:00.000Z",
        });
      default:
        return {
          code: 400,
          message: `unsupported: ${action}`,
          request_id: "t",
          data: null,
        };
    }
  },
};

const kernelSeen: Array<{ path: string; body: unknown }> = [];
const SEARCH_BLOCK = `chat_memory-${TEAM}-agt${AGENT}`;

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
    skillKernel,
    kernelHttp: {
      async postEnvelope(path: string, body: Record<string, unknown>) {
        kernelSeen.push({ path, body });
        if (path === "/v3/atomic/search") {
          return {
            code: 0,
            message: "ok",
            request_id: "t",
            data: {
              items: [{ id: "l1-1", content: "fake atomic hit", score: 0.9 }],
            },
          };
        }
        return {
          code: 0,
          message: "ok",
          request_id: "t",
          data: { messages: [] },
        };
      },
    },
    knowledgeClientFactory: () => ({}),
    knowledgeTaskRegistry: { record: () => {} },
    ingestProgressStore: { get: () => null },
  } as unknown as PanelDeps;
  const app = new Hono();
  const api = new Hono();
  registerSkillProxyRoutes(api, deps);
  registerTaskRoutes(api, deps);
  registerChatMemoryRoutes(api, deps);
  app.route("/api/v1", api);
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("skill proxy", () => {
  it("unknown action -> 404 without touching kernel", async () => {
    skillSeen.length = 0;
    const r = await post("/api/v1/skill/rm -rf", {});
    expect(r.json.code).toBe(404);
    expect(skillSeen).toHaveLength(0);
  });

  it("allowed action forwards body as-is", async () => {
    skillSeen.length = 0;
    const r = await post("/api/v1/skill/list", { team_id: TEAM });
    expect(r.json.code).toBe(0);
    expect(skillSeen).toEqual([{ action: "list", body: { team_id: TEAM } }]);
  });
});

describe("task list-with-agents", () => {
  it("missing team -> 400", async () => {
    const r = await post("/api/v1/task/list-with-agents", {});
    expect(r.json.code).toBe(400);
  });

  it("joins agents onto tasks (no N+1 for client)", async () => {
    const r = await post("/api/v1/task/list-with-agents", { team_id: TEAM });
    expect(r.json.code).toBe(0);
    expect(r.json.data.items[0]).toMatchObject({
      task_id: "task-1",
      agents: [{ agent_id: AGENT }],
    });
    expect(r.json.data.total).toBe(1);
  });
});

describe("chat-memory", () => {
  it("team-assets lists active only (archived filtered)", async () => {
    const r = await post("/api/v1/chat-memory/team-assets", { team_id: TEAM });
    expect(r.json.code).toBe(0);
    expect(r.json.data.items.map((i: any) => i.id)).toEqual(["cm-1"]);
  });

  it("create validates title", async () => {
    const bad = await post("/api/v1/chat-memory/create", {
      team_id: TEAM,
      title: "",
    });
    expect(bad.json.code).toBe(400);
    const r = await post("/api/v1/chat-memory/create", {
      team_id: TEAM,
      title: "notes",
    });
    expect(r.json.code).toBe(0);
    expect(r.json.data).toMatchObject({ id: "cm-new", title: "notes" });
  });
});

describe("chat-memory search + mine", () => {
  it("missing block/query -> 400", async () => {
    const b = await post("/api/v1/chat-memory/search", { query: "x" });
    expect(b.json.code).toBe(400);
    const q = await post("/api/v1/chat-memory/search", {
      block_id: SEARCH_BLOCK,
    });
    expect(q.json.code).toBe(400);
  });

  it("unknown block -> 404 BLOCK_NOT_FOUND", async () => {
    const r = await post("/api/v1/chat-memory/search", {
      block_id: "chat_memory-nope-agtx",
      query: "x",
    });
    expect(r.json.code).toBe(404);
  });

  it("L1 search maps kernel items to blocks", async () => {
    kernelSeen.length = 0;
    const r = await post("/api/v1/chat-memory/search", {
      block_id: SEARCH_BLOCK,
      query: "koi",
    });
    expect(r.json.code).toBe(0);
    expect(r.json.data.items).toEqual([
      {
        id: "l1-1",
        title: "atomic",
        body: "fake atomic hit",
        tags: [],
        refs: [],
        score: 0.9,
        created_at: undefined,
      },
    ]);
    expect(kernelSeen[0].path).toBe("/v3/atomic/search");
  });

  it("mine lists caller assets", async () => {
    const r = await post("/api/v1/chat-memory/mine", { team_id: TEAM });
    expect(r.json.code).toBe(0);
    expect(Array.isArray(r.json.data.items)).toBe(true);
  });
});
