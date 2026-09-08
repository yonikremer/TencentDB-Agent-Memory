/**
 * Org-hierarchy-sync P4 — KS grant mirror client tests (TDD).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { HttpKnowledgeClient } from "../src/panel/kernel/adapters/http-knowledge-client.js";

let server: Server;
let base = "";
const seen: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
let nextJson: unknown = { code: 0, message: "ok", data: {} };

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => resolve(JSON.parse(buf || "{}")));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ path: req.url ?? "", headers: req.headers as Record<string, string>, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(nextJson));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client() {
  return new HttpKnowledgeClient({ baseUrl: base, authToken: "tok", serviceId: "svc-1" });
}

describe("HttpKnowledgeClient grants mirror", () => {
  it("grantsSet posts kind+grants with auth headers", async () => {
    seen.length = 0;
    nextJson = { code: 0, message: "ok", data: { kind: "wiki", knowledge_id: "wiki-1", grants: [{ team_id: "t1", grant_type: "viewer" }] } };
    const res = await client().grantsSet("wiki", "wiki-1", [{ team_id: "t1" }]);
    expect(res.grants).toEqual([{ team_id: "t1", grant_type: "viewer" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe("/v3/grants/set");
    expect(seen[0].headers.authorization).toBe("Bearer tok");
    expect(seen[0].headers["x-tdai-service-id"]).toBe("svc-1");
    expect(seen[0].body).toEqual({ kind: "wiki", knowledge_id: "wiki-1", grants: [{ team_id: "t1" }] });
  });

  it("grantsClear omits team_ids when clearing all", async () => {
    seen.length = 0;
    nextJson = { code: 0, message: "ok", data: { kind: "code-graph", knowledge_id: "cg-1", cleared: 2 } };
    const res = await client().grantsClear("code-graph", "cg-1");
    expect(res.cleared).toBe(2);
    expect(seen[0].path).toBe("/v3/grants/clear");
    expect(seen[0].body).toEqual({ kind: "code-graph", knowledge_id: "cg-1" });
  });

  it("upstream error envelopes reject", async () => {
    nextJson = { code: 404, message: "nope", data: null };
    await expect(client().grantsSet("wiki", "missing", [{ team_id: "t" }])).rejects.toThrow();
  });
});
