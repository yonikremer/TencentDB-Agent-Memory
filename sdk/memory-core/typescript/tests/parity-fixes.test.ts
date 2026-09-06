import { describe, it, expect, vi, afterEach } from "vitest";
import { SkillClient } from "../src/v3/skill-client.js";
import { MemoryClient } from "../src/v3/client.js";
import { HttpTransport } from "../src/http.js";
import { StsCredential } from "../src/cos.js";
import { ParamError } from "../src/errors.js";
import type { Transport } from "../src/client.js";

class FakeTransport implements Transport {
  calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, body });
    return {} as T;
  }
}

describe("getByName does not merge constructor defaults", () => {
  it("throws when team_id/agent_id omitted even with defaults set", () => {
    const fake = new FakeTransport();
    const c = new SkillClient(fake, { teamId: "dt", agentId: "da", userId: "du", taskId: "dtask" });
    expect(() => (c as unknown as { getByName(p: unknown): unknown }).getByName({ skill_name: "x" })).toThrow(ParamError);
  });

  it("uses explicit ids only, ignoring user/task defaults", async () => {
    const fake = new FakeTransport();
    const c = new SkillClient(fake, { teamId: "dt", agentId: "da", userId: "du", taskId: "dtask" });
    await c.getByName({ skill_name: "x", team_id: "T", agent_id: "A" });
    const body = fake.calls[0]!.body;
    expect(body.team_id).toBe("T");
    expect(body.agent_id).toBe("A");
    expect(body.user_id).toBeUndefined();
    expect(body.task_id).toBeUndefined();
    expect(body.skill_name).toBe("x");
  });

  it("rejects empty skill_name", () => {
    const fake = new FakeTransport();
    const c = new SkillClient(fake);
    expect(() => c.getByName({ skill_name: "  ", team_id: "t", agent_id: "a" })).toThrow(ParamError);
  });
});

describe("deleteConversation legacy session_id guard", () => {
  const ISO = { team_id: "t1", agent_id: "a1", user_id: "u1" };
  it("rejects non-string and empty legacy session_id", () => {
    const fake = new FakeTransport();
    const c = new MemoryClient(fake, ISO);
    expect(() => c.deleteConversation({ session_id: 42 as never })).toThrow(ParamError);
    expect(() => c.deleteConversation({ session_id: "" })).toThrow(ParamError);
    expect(() => c.deleteConversation({ session_id: "   " })).toThrow(ParamError);
  });

  it("trims legacy session_id when merging", async () => {
    const fake = new FakeTransport();
    const c = new MemoryClient(fake, ISO);
    await c.deleteConversation({ session_id: "  s9  " });
    expect(fake.calls[0]!.body.session_ids).toEqual(["s9"]);
  });

  it("withIsolation keeps session on empty overrides and applies string override", async () => {
    const fake = new FakeTransport();
    const c = new MemoryClient(fake, { team_id: "t", agent_id: "a", user_id: "u", session_id: "s1" });
    const kept = c.withIsolation({});
    await kept.queryConversation({});
    expect(fake.calls[0]!.body.session_id).toBe("s1");
    const moved = c.withIsolation({ sessionId: "s2", taskId: "tk2" });
    await moved.queryConversation({});
    expect(fake.calls[1]!.body.session_id).toBe("s2");
    expect(fake.calls[1]!.body.task_id).toBe("tk2");
  });
});

describe("HttpTransport request-id fallback", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("business error with no header and no envelope request_id yields empty requestId", async () => {
    const t = new HttpTransport({ endpoint: "http://mem.example.com", apiKey: "k", serviceId: "s" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 40001, message: "bad" }))));
    const err = await t.post("/x").catch((e: unknown) => e);
    expect((err as { requestId: string }).requestId).toBe("");
  });
});

describe("StsCredential missing PathPrefix", () => {
  it("falls back to '/' prefix when PathPrefix absent", () => {
    const c = new StsCredential({
      CosUrl: "https://b.cos.ap-guangzhou.myqcloud.com",
      TmpSecretId: "sid",
      TmpSecretKey: "skey",
      TmpToken: "tok",
      ExpirationTime: new Date(Date.now() + 3600_000).toISOString(),
      PathPrefix: undefined as never,
    });
    expect(c.prefix).toBe("/");
  });
});
