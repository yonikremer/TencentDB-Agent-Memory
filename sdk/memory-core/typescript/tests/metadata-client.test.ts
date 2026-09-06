import { describe, it, expect } from "vitest";
import { MetadataClient } from "../src/v3/metadata-client.js";
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

const CONFIG = { endpoint: "http://mem.example.com", apiKey: "k", serviceId: "s", userKey: "uk" };

describe("MetadataClient construction", () => {
  it("config constructor passes userKey; rejects missing apiKey/serviceId", () => {
    expect(new MetadataClient(CONFIG)).toBeInstanceOf(MetadataClient);
    expect(() => new MetadataClient({ ...CONFIG, apiKey: "" })).toThrow(ParamError);
    expect(() => new MetadataClient({ ...CONFIG, serviceId: "" })).toThrow(ParamError);
    const fake = new FakeTransport();
    expect(new MetadataClient(fake)).toBeInstanceOf(MetadataClient);
  });

  it("body() rejects non-object payloads", async () => {
    const fake = new FakeTransport();
    const c = new MetadataClient(fake);
    expect(() => c.createUser(null as never)).toThrow(ParamError);
    expect(() => c.createUser(["a"] as never)).toThrow(ParamError);
    expect(() => c.createUser("str" as never)).toThrow(ParamError);
    await c.createUser({ username: "u", name: "n", email: "e" });
    expect(fake.calls.at(-1)!.path).toBe("/v3/meta/user/create");
    expect(fake.calls.at(-1)!.body).toEqual({ username: "u", name: "n", email: "e" });
  });
});

describe("MetadataClient endpoints", () => {
  const fake = new FakeTransport({ id: "x" });
  const c = new MetadataClient(fake);
  const lastPath = () => fake.calls[fake.calls.length - 1]!.path;
  const lastBody = () => fake.calls[fake.calls.length - 1]!.body;

  it("user endpoints", async () => {
    await c.createUser({ user_id: "u1", name: "n", email: "e" });
    expect(lastPath()).toBe("/v3/meta/user/create");
    await c.getUser("u1");
    expect(lastBody()).toEqual({ user_id: "u1" });
    await c.getUser({ user_id: "u2" });
    expect(lastBody()).toEqual({ user_id: "u2" });
    await c.deleteUsers(["u1", "u2"]);
    expect(lastBody()).toEqual({ user_ids: ["u1", "u2"] });
    await c.listUsers("t1", { page: 1, page_size: 10 });
    expect(lastBody()).toEqual({ team_id: "t1", page: 1, page_size: 10 });
    await c.listUsers({ team_id: "t1", offset: 2 });
    expect(lastBody()).toEqual({ team_id: "t1", offset: 2 });
  });

  it("user-key endpoints", async () => {
    await c.createUserKey({ user_id: "u1", name: "k1", permissions: [] });
    expect(lastPath()).toBe("/v3/meta/user-key/create");
    await c.listUserKeys("u1", { page: 1 });
    expect(lastBody()).toEqual({ user_id: "u1", page: 1 });
    await c.listUserKeys({ user_id: "u1" });
    expect(lastBody()).toEqual({ user_id: "u1" });
    await c.getUserKey("key-1");
    expect(lastBody()).toEqual({ key_id: "key-1" });
    await c.revokeUserKey("key-1");
    expect(lastBody()).toEqual({ key_id: "key-1" });
    await c.updateUserKey({ key_id: "key-1", status: "active" });
    expect(lastBody()).toEqual({ key_id: "key-1", status: "active" });
  });

  it("team endpoints", async () => {
    await c.createTeam({ name: "team-a" });
    expect(lastPath()).toBe("/v3/meta/team/create");
    await c.getTeam("t1");
    expect(lastPath()).toBe("/v3/meta/team/get");
    await c.updateTeam({ team_id: "t1", name: "renamed" });
    await c.deleteTeams(["t1", "t2"]);
    expect(lastBody()).toEqual({ team_ids: ["t1", "t2"] });
    await c.listTeams("u1", { page: 1 });
    expect(lastBody()).toEqual({ user_id: "u1", page: 1 });
    await c.listTeams({ user_key: "uk-1" });
    expect(lastBody()).toEqual({ user_key: "uk-1" });
    expect(() => c.listTeams({})).toThrow(ParamError);
  });

  it("team-member endpoints", async () => {
    await c.addTeamMember({ team_id: "t1", user_id: "u1", role: "member" });
    expect(lastPath()).toBe("/v3/meta/team-member/add");
    await c.removeTeamMember("t1", "u1");
    expect(lastBody()).toEqual({ team_id: "t1", user_id: "u1" });
    await c.listTeamMembers("t1", { page: 2 });
    expect(lastBody()).toEqual({ team_id: "t1", page: 2 });
    await c.getTeamMember("t1", "u1");
    expect(lastBody()).toEqual({ team_id: "t1", user_id: "u1" });
  });

  it("agent endpoints", async () => {
    await c.createAgent({ name: "a1", agent_id: "ag1" });
    expect(lastPath()).toBe("/v3/meta/agent/create");
    await c.getAgent("ag1");
    expect(lastBody()).toEqual({ agent_id: "ag1" });
    await c.updateAgent({ agent_id: "ag1", name: "a2" });
    await c.deleteAgents(["ag1"]);
    expect(lastBody()).toEqual({ agent_ids: ["ag1"] });
    await c.listAgents({ team_id: "t1" });
    expect(lastPath()).toBe("/v3/meta/agent/list");
    await c.archiveAgent("ag1");
    expect(lastPath()).toBe("/v3/meta/agent/archive");
  });

  it("task endpoints", async () => {
    await c.createTask({ title: "task", team_id: "t1" });
    expect(lastPath()).toBe("/v3/meta/task/create");
    await c.getTask("task-1");
    expect(lastBody()).toEqual({ task_id: "task-1" });
    await c.updateTask({ task_id: "task-1", title: "t2" });
    await c.deleteTasks(["task-1"]);
    expect(lastBody()).toEqual({ task_ids: ["task-1"] });
    await c.listTasks("t1", "running", { page: 1 });
    expect(lastBody()).toEqual({ team_id: "t1", status: "running", page: 1 });
    await c.listTasks({ creator_user_id: "u1" });
    expect(lastBody()).toEqual({ creator_user_id: "u1" });
    await c.listTasks({ creator_user_key: "cuk" });
    expect(lastBody()).toEqual({ creator_user_key: "cuk" });
    expect(() => c.listTasks({})).toThrow(ParamError);
    await c.archiveTask("task-1");
    expect(lastPath()).toBe("/v3/meta/task/archive");
  });

  it("task-agent endpoints", async () => {
    await c.linkTaskAgent("task-1", "ag1", "lead");
    expect(lastBody()).toEqual({ task_id: "task-1", agent_id: "ag1", role_in_task: "lead" });
    await c.unlinkTaskAgent("task-1", "ag1");
    expect(lastBody()).toEqual({ task_id: "task-1", agent_id: "ag1" });
    await c.listTaskAgents("task-1", { page: 1 });
    expect(lastBody()).toEqual({ task_id: "task-1", page: 1 });
  });

  it("participation-log endpoints", async () => {
    await c.appendParticipationLog({ task_id: "task-1", user_id: "u1", action: "join" });
    expect(lastPath()).toBe("/v3/meta/participation-log/append");
    await c.listParticipationLogs({ task_id: "task-1" });
    expect(lastPath()).toBe("/v3/meta/participation-log/list");
  });

  it("asset endpoints", async () => {
    await c.createAsset({ name: "asset", type: "file" });
    expect(lastPath()).toBe("/v3/meta/asset/create");
    await c.getAsset("asset-1");
    expect(lastBody()).toEqual({ asset_id: "asset-1" });
    await c.updateAsset({ asset_id: "asset-1", name: "b" });
    await c.deleteAssets(["asset-1"]);
    expect(lastBody()).toEqual({ asset_ids: ["asset-1"] });
    await c.listAssets({ team_id: "t1" });
    expect(lastPath()).toBe("/v3/meta/asset/list");
    await c.listAccessibleAssets({ user_id: "u1" });
    expect(lastPath()).toBe("/v3/meta/asset/list-accessible");
    await c.touchAssetUsage("asset-1");
    expect(lastBody()).toEqual({ asset_id: "asset-1" });
  });

  it("agent-fixed-asset endpoints", async () => {
    await c.setAgentFixedAssets("ag1", [{ asset_id: "a1", fixed: true }]);
    expect(lastBody()).toEqual({ agent_id: "ag1", bindings: [{ asset_id: "a1", fixed: true }] });
    await c.listAgentFixedAssets("ag1", { page: 1 });
    expect(lastBody()).toEqual({ agent_id: "ag1", page: 1 });
    await c.listAgentFixedAssetsWithDetail({ agent_id: "ag1" });
    expect(lastPath()).toBe("/v3/meta/agent-fixed-asset/list-with-detail");
    await c.summarizeAgentFixedAssetsByAgents({ agent_ids: ["ag1"] });
    expect(lastPath()).toBe("/v3/meta/agent-fixed-asset/summary-by-agents");
  });

  it("acl endpoints", async () => {
    await c.grantAcl({ asset_id: "a1", subject_type: "user", subject_id: "u1", permission: "read" });
    expect(lastPath()).toBe("/v3/meta/acl/grant");
    await c.revokeAcl("acl-1");
    expect(lastBody()).toEqual({ id: "acl-1" });
    await c.listAcl("a1", { page: 1 });
    expect(lastBody()).toEqual({ asset_id: "a1", page: 1 });
    await c.checkAcl({ asset_id: "a1", user_id: "u1", permission: "read" });
    expect(lastPath()).toBe("/v3/meta/acl/check");
  });

  it("auth/config endpoints", async () => {
    await c.verifyAuth("user-key-1");
    expect(lastBody()).toEqual({ user_key: "user-key-1" });
    await c.getInstanceQuota();
    expect(lastPath()).toBe("/v3/meta/instance-quota/get");
    await c.getUserConfig({ user_id: "u1" });
    expect(lastPath()).toBe("/v3/meta/config/user/get");
    await c.setUserConfig({ user_id: "u1", config: { theme: "dark" } });
    expect(lastPath()).toBe("/v3/meta/config/user/set");
  });

  it("knowledge endpoints", async () => {
    await c.createKnowledge({ name: "doc", team_id: "t1", content: "x" });
    expect(lastPath()).toBe("/v3/knowledge/create");
    await c.getKnowledge("kn-1", "t1");
    expect(lastBody()).toEqual({ knowledge_id: "kn-1", team_id: "t1" });
    await c.getKnowledge("kn-2");
    expect(lastBody()).toEqual({ knowledge_id: "kn-2" });
    await c.updateKnowledge({ knowledge_id: "kn-1", content: "y" });
    expect(lastPath()).toBe("/v3/knowledge/update");
    await c.deleteKnowledge(["kn-1"], "t1");
    expect(lastBody()).toEqual({ knowledge_ids: ["kn-1"], team_id: "t1" });
    await c.listKnowledge({ team_id: "t1" });
    expect(lastPath()).toBe("/v3/knowledge/list");
  });
});