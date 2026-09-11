/**
 * server.test.ts — MCP stdio server over InMemoryTransport + fake KS HTTP.
 *
 * Proves the agent-facing seam: tools/list exposes all 12 tools, calls
 * translate to KS HTTP (structured JSON vs {text,isError} passthrough),
 * unknown tools + KS failures surface as isError (never a crash).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "./server.js";
import { MCP_TOOLS } from "./tools.js";

let ks: http.Server;
let ksBase = "";
let ksMode: "ok" | "error" = "ok";
const ksSeen: string[] = [];

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => resolve(buf ? JSON.parse(buf) : {}));
  });
}

beforeAll(async () => {
  ks = http.createServer(async (req, res) => {
    const body = await readBody(req);
    ksSeen.push(`${req.url} query=${(body as any).query ?? (body as any).symbol ?? ""}`);
    res.setHeader("content-type", "application/json");
    if (ksMode === "error") {
      res.writeHead(500);
      res.end(JSON.stringify({ code: 500, message: "fake ks boom", data: null }));
      return;
    }
    const data = (req.url ?? "").includes("code-graph")
      ? { text: "fake symbol body", isError: false }
      : { results: [{ ref: "p1", snippet: "fake wiki hit" }], links: [], count: 1 };
    res.writeHead(200);
    res.end(JSON.stringify({ code: 0, message: "ok", data }));
  });
  await new Promise<void>((resolve) => ks.listen(0, "127.0.0.1", () => resolve()));
  ksBase = `http://127.0.0.1:${(ks.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => ks?.close(() => r()));
});

async function linkedClient() {
  const server = createMcpServer({ baseUrl: ksBase });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

describe("MCP tools/list", () => {
  it("exposes all 12 registry tools with input schemas", async () => {
    const { server, client } = await linkedClient();
    try {
      const res = await client.listTools();
      expect(res.tools).toHaveLength(MCP_TOOLS.length);
      expect(res.tools.map((t) => t.name)).toContain("wiki_search");
      expect(res.tools.map((t) => t.name)).toContain("code_search");
      const search = res.tools.find((t) => t.name === "code_search")!;
      expect((search.inputSchema as any).required).toContain("query");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("MCP tools/call -> KS HTTP", () => {
  it("wiki_search returns structured JSON text", async () => {
    const { server, client } = await linkedClient();
    try {
      ksMode = "ok";
      ksSeen.length = 0;
      const res = await client.callTool({ name: "wiki_search", arguments: { wiki_id: "wiki-x", query: "koi" } });
      expect((res as any).isError).toBeFalsy();
      expect(JSON.stringify(res)).toContain("fake wiki hit");
      expect(ksSeen.join()).toContain("/v3/wiki/search");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("code_search passes {text,isError} through directly", async () => {
    const { server, client } = await linkedClient();
    try {
      ksMode = "ok";
      const res = await client.callTool({ name: "code_search", arguments: { code_graph_id: "cg-x", query: "auth" } });
      expect((res as any).isError).toBe(false);
      expect(JSON.stringify(res)).toContain("fake symbol body");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("unknown tool -> isError (never throws)", async () => {
    const { server, client } = await linkedClient();
    try {
      const res = await client.callTool({ name: "nope", arguments: {} });
      expect((res as any).isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("KS 500 -> isError with message (never a hang)", async () => {
    const { server, client } = await linkedClient();
    try {
      ksMode = "error";
      const res = await client.callTool({ name: "wiki_search", arguments: { wiki_id: "wiki-x", query: "koi" } });
      expect((res as any).isError).toBe(true);
      expect(JSON.stringify(res)).toContain("fake ks boom");
    } finally {
      ksMode = "ok";
      await client.close();
      await server.close();
    }
  });
});
