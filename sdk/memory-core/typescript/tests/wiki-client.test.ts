import { describe, expect, it, vi } from "vitest";
import { WikiClient } from "../src/v3/wiki-client.ts";
import { MetadataClient } from "../src/v3/metadata-client.ts";

function stub() {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    transport: { post: vi.fn(async (path: string, body: unknown) => { calls.push([path, body]); return { ok: true }; }) },
  };
}

describe("WikiClient (KS /v3/wiki/*)", () => {
  it("create carries team_id; rawWrite+ingest hit KS paths", async () => {
    const s = stub();
    const w = new WikiClient(s.transport as any);
    await w.create({ team_id: "t1", name: "docs" });
    await w.rawWrite("t1", "wiki-1", [{ filename: "a.md", content: "# hi" }]);
    await w.ingest("wiki-1");
    expect(s.calls.map((c) => c[0])).toEqual(["/v3/wiki/create", "/v3/wiki/raw/write", "/v3/wiki/ingest"]);
    expect(s.calls[1][1]).toMatchObject({ team_id: "t1", wiki_id: "wiki-1" });
  });
  it("search/graph are id-only; graph opts go flat", async () => {
    const s = stub();
    const w = new WikiClient(s.transport as any);
    await w.search("wiki-1", "q");
    await w.graph("wiki-1");
    expect(s.calls[0]).toEqual(["/v3/wiki/search", expect.objectContaining({ wiki_id: "wiki-1", query: "q" })]);
    expect(s.calls[0][1]).not.toHaveProperty("graph");
    await w.search("wiki-1", "q", 10, { hop: 2, decay: 0.5, minScore: 1 });
    expect(s.calls[2][1]).toMatchObject({ hop: 2, decay: 0.5, minScore: 1 });
  });
  it("search rejects out-of-range graph opts", async () => {
    const s = stub();
    const w = new WikiClient(s.transport as any);
    expect(() => (w as any).search("wiki-1", "q", 20, { hop: 9 })).toThrow();
    expect(() => (w as any).search("wiki-1", "q", 20, { decay: 2 })).toThrow();
    expect(() => (w as any).search("wiki-1", "q", 20, { minScore: -1 })).toThrow();
  });
  it("rejects empty sources", async () => {
    const s = stub();
    const w = new WikiClient(s.transport as any);
    expect(() => (w as any).rawWrite("t1", "wiki-1", [])).toThrow();
  });
});

describe("MetadataClient sharing helpers", () => {
  it("shareAssetWithTeam sets visibility=team", async () => {
    const s = stub();
    const m = new MetadataClient(s.transport as any);
    await m.shareAssetWithTeam("wiki-1");
    expect(s.calls[0]).toEqual(["/v3/meta/asset/update", { asset_id: "wiki-1", visibility: "team" }]);
  });
  it("covers user/team/member primitives", async () => {
    const s = stub();
    const m = new MetadataClient(s.transport as any);
    await m.createUser({ username: "alice" });
    await m.createTeam({ name: "t", owner_user_id: "u1" });
    await m.addTeamMember({ team_id: "t1", user_id: "u1" });
    expect(s.calls.map((c) => c[0])).toEqual(["/v3/meta/user/create", "/v3/meta/team/create", "/v3/meta/team-member/add"]);
  });
});
