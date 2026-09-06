import { describe, expect, it, vi } from "vitest";
import { OpsClient } from "../src/v3/ops-client.ts";

function stub() {
  const calls: Array<[string, string, unknown?]> = [];
  return {
    calls,
    transport: {
      post: vi.fn(async (path: string, body: unknown) => { calls.push(["POST", path, body]); return { ok: true }; }),
      get: vi.fn(async (path: string) => { calls.push(["GET", path]); return { ok: true }; }),
    },
  };
}

describe("OpsClient llm-binding", () => {
  it("set posts proxy body to /set", async () => {
    const s = stub();
    const ops = new OpsClient(s.transport as any);
    await ops.llmBindingSet({ mode: "proxy", api_key: "k", proxy_base_url: "http://proxy" });
    expect(s.calls[0]).toEqual(["POST", "/v3/internal/llm-binding/set",
      expect.objectContaining({ mode: "proxy", proxy_base_url: "http://proxy" })]);
  });
  it("status+list hit POST paths", async () => {
    const s = stub();
    const ops = new OpsClient(s.transport as any);
    await ops.llmBindingStatus();
    await ops.llmBindingList();
    expect(s.calls.map((c) => c[1])).toEqual([
      "/v3/internal/llm-binding/status", "/v3/internal/llm-binding/list"]);
  });
  it("rejects bad mode + missing urls", () => {
    const s = stub();
    const ops = new OpsClient(s.transport as any);
    expect(() => (ops as any).llmBindingSet({ mode: "x" })).toThrow();
    expect(() => (ops as any).llmBindingSet({ mode: "proxy" })).toThrow();
    expect(() => (ops as any).llmBindingSet({ mode: "byo" })).toThrow();
  });
});

describe("OpsClient construction", () => {
  it("rejects empty serviceId/endpoint", () => {
    expect(() => new OpsClient({ endpoint: "", serviceId: "s" } as any)).toThrow();
    expect(() => new OpsClient({ endpoint: "http://ks:8421", serviceId: "" } as any)).toThrow();
  });
});

describe("OpsClient auto-sync", () => {
  it("status uses GET, trigger uses POST", async () => {
    const s = stub();
    const ops = new OpsClient(s.transport as any);
    await ops.autoSyncStatus();
    await ops.autoSyncTrigger();
    expect(s.calls).toEqual([
      ["GET", "/v3/auto-sync/status"],
      ["POST", "/v3/auto-sync/trigger", {}],
    ]);
  });
});
