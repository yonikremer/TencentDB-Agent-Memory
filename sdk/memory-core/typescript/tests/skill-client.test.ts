import { describe, it, expect } from "vitest";
import { SkillClient } from "../src/v3/skill-client.js";
import { SkillErrorCode } from "../src/v3/skill-types.js";
import { ParamError } from "../src/errors.js";
import type { Transport } from "../src/client.js";

class FakeTransport implements Transport {
  calls: Array<{ path: string; body: Record<string, unknown>; method: string }> = [];
  constructor(private result: unknown = {}) {}
  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, body, method: "POST" });
    return this.result as T;
  }
}

const CONFIG = {
  endpoint: "http://mem.example.com",
  apiKey: "k",
  serviceId: "s",
  teamId: "dt",
  agentId: "da",
  userId: "du",
  taskId: "dtask",
};

function last(fake: FakeTransport) {
  return fake.calls[fake.calls.length - 1]!;
}

describe("SkillClient construction", () => {
  it("constructs from config, transport with defaults, and transport without", () => {
    expect(new SkillClient(CONFIG)).toBeInstanceOf(SkillClient);
    const fake = new FakeTransport();
    expect(new SkillClient(fake)).toBeInstanceOf(SkillClient);
    expect(new SkillClient(fake, { teamId: "t" })).toBeInstanceOf(SkillClient);
  });

  it("withDefaults clones with merged defaults", async () => {
    const fake = new FakeTransport();
    const c = new SkillClient(fake, { teamId: "t0" });
    const c2 = c.withDefaults({ teamId: "t1", agentId: "a1" });
    await c2.list();
    const body = last(fake).body as Record<string, string | undefined>;
    expect(body.team_id).toBe("t1");
    expect(body.agent_id).toBe("a1");
  });
});

describe("SkillClient static encoders", () => {
  it("encodeUtf8 builds utf-8 payload", () => {
    expect(SkillClient.encodeUtf8("SKILL.md", "# hi")).toEqual({
      path: "SKILL.md", content: "# hi", encoding: "utf-8", mime_type: undefined, is_executable: undefined,
    });
    expect(SkillClient.encodeUtf8("run.py", "print(1)", { mime_type: "text/x-python", is_executable: true }))
      .toEqual({ path: "run.py", content: "print(1)", encoding: "utf-8", mime_type: "text/x-python", is_executable: true });
  });

  it("encodeBase64 from string, ArrayBuffer, Uint8Array, and fallback", () => {
    expect(SkillClient.encodeBase64("f.bin", "aGVsbG8=")).toMatchObject({ encoding: "base64", content: "aGVsbG8=" });
    const ab = new Uint8Array([1, 2, 3]).buffer;
    expect(SkillClient.encodeBase64("f.bin", ab).content).toBe("AQID");
    expect(SkillClient.encodeBase64("f.bin", new Uint8Array([1, 2, 3])).content).toBe("AQID");
    expect(SkillClient.encodeBase64("f.bin", Buffer.from("###", "utf8")).content).toBe("IyMj");
    // fallback: plain array-like treated via Buffer.from
    expect(SkillClient.encodeBase64("f.bin", [1, 2, 3] as unknown as Buffer).content).toBe("AQID");
    expect(SkillClient.encodeBase64("f.bin", new Uint8Array([9]), { mime_type: "m", is_executable: true }))
      .toMatchObject({ mime_type: "m", is_executable: true });
  });
});

describe("SkillClient endpoints", () => {
  const fake = new FakeTransport({ id: "s" });
  const c = new SkillClient(fake, { teamId: "dt", agentId: "da", userId: "du", taskId: "dtask" });
  const lastPath = () => last(fake).path;
  const lastBody = () => last(fake).body as Record<string, unknown>;

  it("create merges defaults and strips undefined", async () => {
    await c.create({ name: "n", content: "c" });
    expect(lastPath()).toBe("/v3/skill/create");
    expect(lastBody()).toEqual({ team_id: "dt", agent_id: "da", user_id: "du", task_id: "dtask", name: "n", content: "c" });
    await c.create({ name: "n2", content: "c2", resources: [], metadata: { k: "v" } });
    expect(lastBody()).toEqual({ team_id: "dt", agent_id: "da", user_id: "du", task_id: "dtask", name: "n2", content: "c2", resources: [], metadata: { k: "v" } });
  });

  it("update and patch post fields", async () => {
    await c.update({ skill_id: "sk-1", expected_version: 2, content: "v2" });
    expect(lastPath()).toBe("/v3/skill/update");
    expect(lastBody().expected_version).toBe(2);
    await c.patch({ skill_id: "sk-1", old_string: "a", new_string: "b", replace_all: true });
    expect(lastPath()).toBe("/v3/skill/patch");
    expect(lastBody()).toEqual({ team_id: "dt", agent_id: "da", user_id: "du", task_id: "dtask", skill_id: "sk-1", old_string: "a", new_string: "b", replace_all: true });
  });

  it("delete and get post fields", async () => {
    await c.delete({ skill_id: "sk-1", expected_version: 1 });
    expect(lastPath()).toBe("/v3/skill/delete");
    await c.get({ skill_id: "sk-1", version: 3, include_content: true, include_manifest: false });
    expect(lastPath()).toBe("/v3/skill/get");
    expect(lastBody().include_content).toBe(true);
  });

  it("getByName requires team_id and agent_id", async () => {
    const bare = new SkillClient(fake);
    expect(() => bare.getByName({ skill_name: "x" })).toThrow(ParamError);
    await c.getByName({ skill_name: "x", team_id: "dt", agent_id: "a1", version: 2 });
    expect(lastPath()).toBe("/v3/skill/get-by-name");
    expect(lastBody().skill_name).toBe("x");
    expect(lastBody().team_id).toBe("dt");
  });

  it("list, search, versions", async () => {
    await c.list({ filters: { status: "active" }, pagination: { page: 1 } });
    expect(lastPath()).toBe("/v3/skill/list");
    await c.search({ query: "q", top_k: 5, mode: "hybrid", scope: "all" });
    expect(lastPath()).toBe("/v3/skill/search");
    await c.versions({ skill_id: "sk-1", pagination: { page: 1 } });
    expect(lastPath()).toBe("/v3/skill/versions");
  });

  it("file endpoints", async () => {
    await c.writeFiles({ skill_id: "sk-1", files: [{ path: "a", content: "b", encoding: "utf-8" }] });
    expect(lastPath()).toBe("/v3/skill/files/write");
    await c.removeFiles({ skill_id: "sk-1", paths: ["a"] });
    expect(lastPath()).toBe("/v3/skill/files/remove");
    await c.readFile({ skill_id: "sk-1", path: "a", version: 1, encoding: "base64" });
    expect(lastPath()).toBe("/v3/skill/files/read");
    await c.exportSkill({ skill_id: "sk-1", version: 1, format: "zip" });
    expect(lastPath()).toBe("/v3/skill/export");
  });

  it("listing", async () => {
    await c.listing({ query: "x", char_budget: 100 });
    expect(lastPath()).toBe("/v3/skill/listing");
  });

  it("extract validates ids and messages", async () => {
    const bare = new SkillClient(fake);
    expect(() => bare.extract({ user_id: "", team_id: "t", agent_id: "a", messages: [{} as never] }))
      .toThrow(ParamError);
    expect(() => c.extract({ messages: [] })).toThrow(ParamError);
    await c.extract({ space_id: "sp", session_id: "se", user_id: "du", team_id: "dt", agent_id: "a1", messages: [{ role: "user", content: "hi" }], reason: "why", options: {} });
    expect(lastPath()).toBe("/v3/skill/extract");
    const b = lastBody();
    expect(b.user_id).toBe("du");
    expect(b.team_id).toBe("dt");
    expect(b.messages).toHaveLength(1);
  });

  it("conversationAdd validates and does not merge defaults", async () => {
    expect(() => c.conversationAdd({ messages: [{ role: "user", content: "x" }] })).toThrow(ParamError);
    expect(() => c.conversationAdd({ session_id: "s", user_id: "u", team_id: "t", agent_id: "a", messages: [] }))
      .toThrow(ParamError);
    await c.conversationAdd({ session_id: "s1", space_id: "sp", user_id: "u1", team_id: "t1", agent_id: "a1", task_id: "tk", messages: [{ role: "user", content: "x" }] });
    expect(lastPath()).toBe("/v3/skill/conversation/add");
    const b = lastBody();
    expect(b.session_id).toBe("s1");
    expect(b.task_id).toBe("tk");
    expect(b.team_id).toBe("t1");
  });

  it("conversationForceArchive validates required fields", async () => {
    expect(() => c.conversationForceArchive({ session_id: "s", user_id: "u", team_id: "t", agent_id: "a" }))
      .toThrow(ParamError);
    await c.conversationForceArchive({ session_id: "s", space_id: "sp", user_id: "u", team_id: "t", agent_id: "a", reason: "done" });
    expect(lastPath()).toBe("/v3/skill/conversation/force-archive");
  });
});

describe("SkillErrorCode", () => {
  it("exposes documented codes", () => {
    expect(SkillErrorCode.NOT_FOUND).toBe(40401);
    expect(SkillErrorCode.VERSION_STALE).toBe(40901);
    expect(SkillErrorCode.BAD_REQUEST).toBe(40001);
  });
});