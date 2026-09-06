import { describe, it, expect } from "vitest";
import { MemoryPromptClient } from "../src/v3/memory-prompt-client.js";
import { ParamError } from "../src/errors.js";
import type { Transport } from "../src/client.js";

class FakeTransport implements Transport {
  calls: Array<{ path: string; body: Record<string, unknown>; method: string }> = [];
  constructor(private result: unknown = {}) {}
  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, body, method: "POST" });
    return this.result as T;
  }
  async get<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, body, method: "GET" });
    return this.result as T;
  }
}

class FakeTransportNoGet implements Transport {
  calls: Array<{ path: string; body: Record<string, unknown>; method: string }> = [];
  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, body, method: "POST" });
    return {} as T;
  }
}

const CONFIG = {
  endpoint: "http://mem.example.com",
  apiKey: "k",
  serviceId: "s",
  teamId: "dt",
  agentId: "da",
};

function last(fake: FakeTransport | FakeTransportNoGet) {
  return fake.calls[fake.calls.length - 1]!;
}

describe("MemoryPromptClient", () => {
  it("constructs from config and from transport (with/without defaults)", () => {
    expect(new MemoryPromptClient(CONFIG)).toBeInstanceOf(MemoryPromptClient);
    expect(new MemoryPromptClient(CONFIG, {})).toBeInstanceOf(MemoryPromptClient);
    const fake = new FakeTransport();
    expect(new MemoryPromptClient(fake)).toBeInstanceOf(MemoryPromptClient);
    expect(new MemoryPromptClient(fake, { teamId: "t" })).toBeInstanceOf(MemoryPromptClient);
  });

  it("create validates name and prompt", async () => {
    const fake = new FakeTransport();
    const c = new MemoryPromptClient(fake);
    expect(() => c.create({ name: "", prompt: "p" })).toThrow(ParamError);
    expect(() => c.create({ name: "n", prompt: "  " })).toThrow(ParamError);
    await c.create({ name: "n", prompt: "p", resource_manifest: ["a"] });
    expect(last(fake).path).toBe("/v3/memory-prompt/create");
    expect(last(fake).body.name).toBe("n");
  });

  it("get validates id and uses GET", async () => {
    const fake = new FakeTransport();
    const c = new MemoryPromptClient(fake);
    expect(() => c.get("")).toThrow(ParamError);
    await c.get("mp-1");
    expect(last(fake).method).toBe("GET");
    expect(last(fake).body).toEqual({ memory_prompt_id: "mp-1" });
    expect(last(fake).path).toBe("/v3/memory-prompt/get");
  });

  it("get falls back to POST when transport has no get", async () => {
    const fake = new FakeTransportNoGet();
    const c = new MemoryPromptClient(fake);
    await c.get("mp-2");
    expect(last(fake).method).toBe("POST");
  });

  it("list passes params or empty object", async () => {
    const fake = new FakeTransport();
    const c = new MemoryPromptClient(fake);
    await c.list();
    expect(last(fake).path).toBe("/v3/memory-prompt/get");
    await c.list({ layer: "l2", resource_kind: "WORKFLOW" });
    expect(last(fake).body).toEqual({ layer: "l2", resource_kind: "WORKFLOW" });
  });

  it("getEffective resolves defaults and throws without team id", async () => {
    const fake = new FakeTransport();
    const c = new MemoryPromptClient(fake, { teamId: "dt", agentId: "da" });
    await c.getEffective({});
    expect(last(fake).body).toEqual({ team_id: "dt", agent_id: "da" });
    await c.getEffective({ team_id: "t2", agent_id: "a2", layer: "l1" });
    expect(last(fake).body).toEqual({ team_id: "t2", agent_id: "a2", layer: "l1" });
    const c2 = new MemoryPromptClient(fake);
    expect(() => c2.getEffective({})).toThrow(ParamError);
  });

  it("update validates id and requires name or prompt", async () => {
    const fake = new FakeTransport();
    const c = new MemoryPromptClient(fake);
    expect(() => c.update({ memory_prompt_id: " " })).toThrow(ParamError);
    expect(() => c.update({ memory_prompt_id: "mp" })).toThrow(ParamError);
    await c.update({ memory_prompt_id: "mp", name: "new" });
    expect(last(fake).body).toEqual({ memory_prompt_id: "mp", name: "new" });
  });

  it("delete validates and dedupes ids", async () => {
    const fake = new FakeTransport();
    const c = new MemoryPromptClient(fake);
    expect(() => c.delete({ memory_prompt_ids: [] })).toThrow(ParamError);
    expect(() => c.delete({ memory_prompt_ids: ["ok", " " as string] })).toThrow(ParamError);
    await c.delete({ memory_prompt_ids: ["a", "b", "a"] });
    expect(last(fake).body).toEqual({ memory_prompt_ids: ["a", "b"] });
  });

  it("apply validates target and memory_prompt_id", async () => {
    const fake = new FakeTransport();
    const c = new MemoryPromptClient(fake, { teamId: "dt" });
    expect(() => c.apply({ memory_prompt_id: "mp", agent_ids: [] })).toThrow(ParamError);
    expect(() => c.apply({ memory_prompt_id: "mp", agent_ids: [" " as string] })).toThrow(ParamError);
    expect(() => c.apply({ memory_prompt_id: "", agent_ids: ["a"] })).toThrow(ParamError);
    const c2 = new MemoryPromptClient(fake);
    expect(() => c2.apply({ memory_prompt_id: "mp", agent_ids: ["a1"] })).toThrow(ParamError);
    await c.apply({ memory_prompt_id: "mp", agent_ids: ["a1", "a2"], layer: "l2" });
    const b = last(fake).body;
    expect(b.action).toBe("apply");
    expect(b.team_id).toBe("dt");
    expect(b.agent_ids).toEqual(["a1", "a2"]);
  });

  it("clear validates target and posts clear action", async () => {
    const fake = new FakeTransport();
    const c = new MemoryPromptClient(fake, { teamId: "dt" });
    await c.clear({ agent_ids: ["a1"] });
    const b = last(fake).body;
    expect(b.action).toBe("clear");
    expect(b.team_id).toBe("dt");
    expect(b.memory_prompt_id).toBeUndefined();
    const c2 = new MemoryPromptClient(fake);
    expect(() => c2.clear({ agent_ids: ["a1"] })).toThrow(ParamError);
  });

  it("listSettings enforces target rules", async () => {
    const fake = new FakeTransport();
    const c = new MemoryPromptClient(fake, { teamId: "dt", agentId: "da" });
    await c.listSettings();
    expect(last(fake).body).toEqual({ team_id: "dt", agent_id: "da" });
    const bare = new MemoryPromptClient(fake);
    await bare.listSettings({ target_type: "instance" });
    expect(last(fake).body.target_type).toBe("instance");
    expect(() => c.listSettings({ target_type: "team", agent_id: "x" })).toThrow(ParamError);
    expect(() => c.listSettings({ target_type: "instance", team_id: "x" })).toThrow(ParamError);
    const c2 = new MemoryPromptClient(fake);
    expect(() => c2.listSettings({ agent_id: "a", team_id: undefined })).toThrow(ParamError);
  });

  it("listSettingLogs enforces target rules", async () => {
    const fake = new FakeTransport();
    const c = new MemoryPromptClient(fake, { teamId: "dt" });
    await c.listSettingLogs({ memory_prompt_id: "mp" });
    expect(last(fake).body.team_id).toBe("dt");
    await c.listSettingLogs({ team_id: "t9" });
    expect(last(fake).body.team_id).toBe("t9");
    const c2 = new MemoryPromptClient(fake);
    expect(() => c2.listSettingLogs({})).toThrow(ParamError);
    expect(() => c2.listSettingLogs({ agent_id: "a" })).toThrow(ParamError);
  });
});