/**
 * v3-only routing contract (API consolidation):
 * - legacy /v2/* data-plane, entity and offload paths are no longer handled
 * - /v3/* data plane routes with strict isolation (422 without the triad)
 * - /v3/pipeline/status is exempt from the triad (instance-level introspection)
 * - /v3/offload/* routes via the offload router
 */
import { describe, it, expect } from "vitest";
import { handleV3Route } from "./v3-router.js";
import type { V3RouterDeps } from "./v3-router.js";
import { handleOffloadV3Route } from "../offload_server/router.js";

function req(pathname: string, headers: Record<string, string> = {}) {
  return {
    url: pathname,
    method: "POST",
    headers: {
      authorization: "Bearer k",
      "x-tdai-service-id": "svc",
      ...headers,
    },
  } as never;
}

interface Seen {
  status: number;
  body: unknown;
}
function harness() {
  const seen: Seen[] = [];
  const sendJson = (_res: unknown, status: number, body: unknown) => {
    seen.push({ status, body });
  };
  const parseJsonBody = async <T>(): Promise<T> => ({}) as T;
  return { seen, sendJson, parseJsonBody };
}

const deps = {
  getStore: () => undefined,
  getEmbedding: () => undefined,
  getStorage: () => undefined,
  deployMode: "standalone",
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
} as unknown as V3RouterDeps;

async function route(pathname: string, headers: Record<string, string> = {}) {
  const { seen, sendJson, parseJsonBody } = harness();
  const handled = await handleV3Route(
    req(pathname, headers),
    {} as never,
    pathname,
    "POST",
    parseJsonBody,
    sendJson as never,
    deps,
  );
  const last = seen[seen.length - 1];
  return {
    handled,
    status: last?.status,
    code: (last?.body as { code?: number } | undefined)?.code,
  };
}

const TRIAD = {
  "x-tdai-team-id": "t",
  "x-tdai-agent-id": "a",
  "x-tdai-user-id": "u",
  "x-tdai-session-id": "s",
};

describe("v3-only data-plane routing", () => {
  it("rejects legacy /v2 data-plane paths", async () => {
    for (const p of [
      "/v2/conversation/add",
      "/v2/atomic/query",
      "/v2/scenario/ls",
      "/v2/core/write",
    ]) {
      expect((await route(p)).handled).toBe(false);
    }
  });
  it("rejects legacy /v2 entity paths", async () => {
    for (const p of [
      "/v2/team/create",
      "/v2/user/get",
      "/v2/agent/delete",
      "/v2/task/update",
    ]) {
      expect((await route(p)).handled).toBe(false);
    }
  });
  it("routes /v3 data plane with strict isolation (422 without triad)", async () => {
    const r = await route("/v3/conversation/add");
    expect(r.handled).toBe(true);
    expect(r.status).toBe(422);
  });
  it("passes strict isolation with triad headers", async () => {
    const r = await route("/v3/conversation/add", TRIAD);
    expect(r.handled).toBe(true);
    expect(r.status).not.toBe(422); // 503: no store in this harness
  });
  it("routes /v3/pipeline/status without isolation triad", async () => {
    const r = await route("/v3/pipeline/status");
    expect(r.handled).toBe(true);
    expect(r.status).toBe(503); // standalone without stateBackend
  });
});

describe("v3 offload routing", () => {
  async function offload(pathname: string, storage?: unknown) {
    const { seen, sendJson, parseJsonBody } = harness();
    const handled = await handleOffloadV3Route(
      req(pathname) as never,
      {} as never,
      pathname,
      "POST",
      parseJsonBody,
      sendJson as never,
      {
        getStorage: () => storage as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
    );
    const last = seen[seen.length - 1];
    return { handled, status: last?.status };
  }
  it("rejects legacy /v2/offload paths", async () => {
    for (const p of [
      "/v2/offload/ingest",
      "/v2/offload/compact",
      "/v2/offload/query-mmd",
    ]) {
      expect((await offload(p)).handled).toBe(false);
    }
  });
  it("routes /v3/offload paths (503 without storage)", async () => {
    for (const p of ["/v3/offload/ingest", "/v3/offload/compact"]) {
      const r = await offload(p);
      expect(r.handled).toBe(true);
      expect(r.status).toBe(503);
    }
  });
  it("validates /v3/offload/query-mmd body (400 on empty)", async () => {
    const r = await offload("/v3/offload/query-mmd", {});
    expect(r.handled).toBe(true);
    expect(r.status).toBe(400);
  });
});
