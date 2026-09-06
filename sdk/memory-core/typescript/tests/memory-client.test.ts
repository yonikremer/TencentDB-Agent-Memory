import { describe, it, expect } from "vitest";
import { MemoryClient } from "../src/v3/client.js";
import { ParamError } from "../src/errors.js";
import type { Transport } from "../src/client.js";

class FakeTransport implements Transport {
  calls: Array<{ path: string; body?: Record<string, unknown>; method: string }> = [];
  constructor(private result: unknown = {}) {}
  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, body, method: "POST" });
    return this.result as T;
  }
}

const ISO = { team_id: "t1", agent_id: "a1", user_id: "u1", session_id: "sess-1", task_id: "task-1" };
const CONFIG = {
  endpoint: "http://mem.example.com",
  apiKey: "k",
  serviceId: "s",
  teamId: "t1",
  agentId: "a1",
  userId: "u1",
  sessionId: "sess-1",
  taskId: "task-1",
};

function lastBody(fake: FakeTransport): Record<string, unknown> {
  return fake.calls[fake.calls.length - 1]!.body!;
}

describe("MemoryClient construction", () => {
  it("config constructor builds V3HttpTransport", () => {
    expect(new MemoryClient(CONFIG)).toBeInstanceOf(MemoryClient);
  });

  it("transport constructor requires isolation context", () => {
    const fake = new FakeTransport({});
    expect(() => new MemoryClient(fake, undefined as never)).toThrow(ParamError);
    const c = new MemoryClient(fake, { team_id: "t1", agent_id: "a1", user_id: "u1", session_id: "s", task_id: "tk" });
    expect(c).toBeInstanceOf(MemoryClient);
  });

  it("transport constructor rejects missing isolation ids", () => {
    const fake = new FakeTransport({}) as unknown as Transport;
    expect(() => new MemoryClient(fake, { team_id: "", agent_id: "a", user_id: "u" })).toThrow(ParamError);
    expect(() => new MemoryClient(fake, { team_id: "t", agent_id: "", user_id: "u" })).toThrow(ParamError);
    expect(() => new MemoryClient(fake, { team_id: "t", agent_id: "a", user_id: "" })).toThrow(ParamError);
  });
});

describe("IsolationContext resolution", () => {
  it("withIsolation applies overrides and null resets", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, { team_id: "t1", agent_id: "a1", user_id: "u1", session_id: "s1", task_id: "tk1" });
    const c2 = c.withIsolation({ teamId: "t2", sessionId: null, taskId: null });
    await c2.queryConversation({});
    const body = lastBody(fake);
    expect(body.team_id).toBe("t2");
    expect(body.session_id).toBeUndefined();
    expect(body.task_id).toBeUndefined();
    expect(body.agent_id).toBe("a1");
  });

  it("addConversation resolves per-call session override", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, { team_id: "t", agent_id: "a", user_id: "u" });
    await c.addConversation({ session_id: "per-call", messages: [{ role: "user", content: "hi" }] });
    const body = lastBody(fake);
    expect(body.session_id).toBe("per-call");
    expect(body.team_id).toBe("t");
  });

  it("addConversation uses constructor session and throws when absent", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, { team_id: "t", agent_id: "a", user_id: "u", session_id: "cs" });
    await c.addConversation({ messages: [] });
    expect(lastBody(fake).session_id).toBe("cs");
    const c2 = new MemoryClient(fake, { team_id: "t", agent_id: "a", user_id: "u" });
    expect(() => c2.addConversation({ messages: [] })).toThrow(ParamError);
  });
});

describe("MemoryClient L0 conversation", () => {
  it("queryConversation strips undefined and resolves session", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.queryConversation({ limit: 10, time_start: 1 });
    const body = lastBody(fake);
    expect(body.session_id).toBe("sess-1");
    expect(body.limit).toBe(10);
    expect(body.time_start).toBe(1);
    expect(body.time_end).toBeUndefined();
    expect(body.offset).toBeUndefined();
    expect(fake.calls.at(-1)!.path).toBe("/v3/conversation/query");
  });

  it("queryConversation defaults to empty params", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.queryConversation();
    expect(fake.calls.at(-1)!.path).toBe("/v3/conversation/query");
  });

  it("countConversation resolves session and posts filters", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.countConversation({ time_start: 0, time_end: 9, session_id: "sess-2" });
    const body = lastBody(fake);
    expect(body.session_id).toBe("sess-2");
    expect(body.time_start).toBe(0);
    expect(body.time_end).toBe(9);
  });

  it("searchConversation posts query", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.searchConversation({ query: "chicken", session_id: "s2", limit: 4, time_start: 1, time_end: 2 });
    const body = lastBody(fake);
    expect(body.query).toBe("chicken");
    expect(body.session_id).toBe("s2");
    expect(body.limit).toBe(4);
    expect(fake.calls.at(-1)!.path).toBe("/v3/conversation/search");
  });

  it("countConversation default empty params", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.countConversation();
    expect(lastBody(fake).session_id).toBe("sess-1");
  });

  it("deleteConversation accepts message_ids, session_ids, both and legacy singular", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.deleteConversation({ message_ids: ["m1", "m1"] });
    expect(lastBody(fake).message_ids).toEqual(["m1"]);
    await c.deleteConversation({ session_ids: ["s1", "s2"] });
    expect(lastBody(fake).session_ids).toEqual(["s1", "s2"]);
    await c.deleteConversation({ message_ids: ["m2"], session_ids: ["s3"], session_id: "s3" });
    expect(lastBody(fake).session_ids).toEqual(["s3"]);
    await c.deleteConversation({ session_id: "legacy" });
    expect(lastBody(fake).session_ids).toEqual(["legacy"]);
    expect(lastBody(fake).message_ids).toBeUndefined();
  });

  it("deleteConversation validates inputs", () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    expect(() => c.deleteConversation({})).toThrow(ParamError);
    expect(() => c.deleteConversation({ message_ids: "nope" as never })).toThrow(ParamError);
    expect(() => c.deleteConversation({ message_ids: ["ok", ""] })).toThrow(ParamError);
    expect(() => c.deleteConversation({ message_ids: [42 as never] })).toThrow(ParamError);
    expect(() => c.deleteConversation({ message_ids: Array.from({ length: 5001 }, (_, i) => `m${i}`) })).toThrow(ParamError);
    expect(() => c.deleteConversation({ message_ids: ["m1"], session_id: "" })).toThrow(ParamError);
    expect(() => c.deleteConversation({ session_ids: "bad" as never })).toThrow(ParamError);
  });
});

describe("MemoryClient L1 atomic", () => {
  it("updateAtomic posts fields", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.updateAtomic({ id: "at-1", content: "x", session_id: "s9" });
    const body = lastBody(fake);
    expect(body.id).toBe("at-1");
    expect(body.content).toBe("x");
    expect(body.session_id).toBe("s9");
    expect(body.background).toBeUndefined();
  });

  it("queryAtomic strips undefined", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.queryAtomic({ type: "persona", limit: 3, offset: 1, time_start: 0, time_end: 5 });
    const body = lastBody(fake);
    expect(body.type).toBe("persona");
    expect(body.limit).toBe(3);
    expect(body.offset).toBe(1);
  });

  it("searchAtomic posts query", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.searchAtomic({ query: "pasta", type: "scene", limit: 2, time_start: 1, time_end: 3 });
    const body = lastBody(fake);
    expect(body.query).toBe("pasta");
    expect(body.type).toBe("scene");
    expect(fake.calls.at(-1)!.path).toBe("/v3/atomic/search");
  });

  it("deleteAtomic validates and posts ids", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    expect(() => c.deleteAtomic({ ids: [] })).toThrow(ParamError);
    expect(() => c.deleteAtomic({ ids: ["a", " " as string] })).toThrow(ParamError);
    expect(() => c.deleteAtomic({ ids: [5 as never] })).toThrow(ParamError);
    expect(() => c.deleteAtomic({ ids: Array.from({ length: 5001 }, (_, i) => `a${i}`) })).toThrow(ParamError);
    await c.deleteAtomic({ ids: ["x", "y", "x"], session_id: "s1" });
    const body = lastBody(fake);
    expect(body.ids).toEqual(["x", "y"]);
    expect(body.session_id).toBe("s1");
  });

  it("countAtomic posts filters", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.countAtomic({ type: "scene", time_start: 1, time_end: 2 });
    const body = lastBody(fake);
    expect(body.type).toBe("scene");
    expect(body.time_start).toBe(1);
  });
});

describe("MemoryClient L2 scenario + L3 core", () => {
  it("scenario endpoints post expected paths", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.listScenarios();
    expect(fake.calls.at(-1)!.path).toBe("/v3/scenario/ls");
    await c.listScenarios({ path_prefix: "p/" });
    expect(lastBody(fake).path_prefix).toBe("p/");
    await c.readScenario({ path: "p/1.md" });
    expect(lastBody(fake).path).toBe("p/1.md");
    await c.writeScenario({ path: "p/2.md", content: "# c", summary: "sum" });
    const wb = lastBody(fake);
    expect(wb.content).toBe("# c");
    expect(wb.summary).toBe("sum");
    await c.rmScenario({ path: "p/1.md" });
    expect(fake.calls.at(-1)!.path).toBe("/v3/scenario/rm");
    await c.countScenario({ path_prefix: "q/" });
    expect(fake.calls.at(-1)!.path).toBe("/v3/scenario/count");
    expect(lastBody(fake).path_prefix).toBe("q/");
    await c.countScenario();
    expect(lastBody(fake).path_prefix).toBeUndefined();
  });

  it("core endpoints post isolation body", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.readCore();
    expect(fake.calls.at(-1)!.path).toBe("/v3/core/read");
    expect(lastBody(fake).task_id).toBe("task-1");
    await c.writeCore({ content: "ctx" });
    expect(lastBody(fake).content).toBe("ctx");
    await c.countCore();
    expect(fake.calls.at(-1)!.path).toBe("/v3/core/count");
  });
});

describe("MemoryClient chat memory", () => {
  it("clearChatMemory posts memory_ids without isolation", async () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    await c.clearChatMemory({ memory_ids: ["mem-1", "mem-1"] });
    expect(lastBody(fake)).toEqual({ memory_ids: ["mem-1"] });
    expect(fake.calls.at(-1)!.path).toBe("/v3/chat-memory/clear");
  });

  it("clearChatMemory validates memory_ids", () => {
    const fake = new FakeTransport({});
    const c = new MemoryClient(fake, ISO);
    expect(() => c.clearChatMemory({ memory_ids: [] })).toThrow(ParamError);
    expect(() => c.clearChatMemory({ memory_ids: ["ok", ""] })).toThrow(ParamError);
    expect(() => c.clearChatMemory({ memory_ids: "nope" as never })).toThrow(ParamError);
    expect(() => c.clearChatMemory({ memory_ids: Array.from({ length: 101 }, (_, i) => `m${i}`) })).toThrow(ParamError);
  });
});