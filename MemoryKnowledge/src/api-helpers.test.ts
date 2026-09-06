/**
 * api-helpers.test.ts — Unit tests for shared HTTP/API helper functions.
 */
import { describe, it, expect } from "vitest";
import {
  SERVICE_ID_HEADER,
  isValidIdSegment,
  extractServiceId,
  extractIdFields,
  wrapOk,
  wrapError,
  toWikiDetail,
  toCodeGraphDetail,
} from "./api-helpers.js";
import type { WikiRow, CodeGraphRow } from "./store/index.js";

const baseWiki = (over: Partial<WikiRow> = {}): WikiRow =>
  ({
    wiki_id: "wiki-abcdef12",
    team_id: "t1",
    name: "Wiki",
    service_url: null,
    summary: null,
    status: "ready",
    internal_status: "ready",
    sync_error: null,
    version: 3,
    owner_user_id: null,
    page_count: null,
    last_sync_at: null,
    created_at: "2020-01-01",
    updated_at: "2020-01-02",
    ...over,
  }) as WikiRow;

const baseCg = (over: Partial<CodeGraphRow> = {}): CodeGraphRow =>
  ({
    code_graph_id: "cg-abcdef12",
    team_id: "t1",
    repo_name: "repo",
    repo_url: "http://x",
    branch: "main",
    commit_hash: null,
    service_url: null,
    summary: null,
    status: "ready",
    sync_error: null,
    version: 2,
    owner_user_id: null,
    stats_json: null,
    last_sync_at: null,
    created_at: "2020-01-01",
    updated_at: "2020-01-02",
    ...over,
  }) as CodeGraphRow;

describe("isValidIdSegment", () => {
  it("accepts bounded whitelist strings", () => {
    expect(isValidIdSegment("abc123")).toBe(true);
    expect(isValidIdSegment("a-b_c")).toBe(true);
    expect(isValidIdSegment("A")).toBe(true);
  });

  it("rejects non-strings, empty, too-long, illegal chars", () => {
    expect(isValidIdSegment(undefined)).toBe(false);
    expect(isValidIdSegment(null)).toBe(false);
    expect(isValidIdSegment(123)).toBe(false);
    expect(isValidIdSegment("")).toBe(false);
    expect(isValidIdSegment("a".repeat(201))).toBe(false);
    expect(isValidIdSegment("a b")).toBe(false);
    expect(isValidIdSegment("../etc")).toBe(false);
    expect(isValidIdSegment("a/b")).toBe(false);
    expect(isValidIdSegment("a.b")).toBe(false);
  });
});

describe("extractServiceId", () => {
  it("returns valid value or null", () => {
    expect(extractServiceId("svc-1")).toBe("svc-1");
    expect(extractServiceId(undefined)).toBeNull();
    expect(extractServiceId(null)).toBeNull();
    expect(extractServiceId("bad path")).toBeNull();
  });
});

describe("extractIdFields", () => {
  it("returns null when service_id invalid", () => {
    expect(extractIdFields(null, { team_id: "t" })).toBeNull();
    expect(extractIdFields("bad/id", { team_id: "t" })).toBeNull();
  });

  it("returns null when team_id invalid", () => {
    expect(extractIdFields("svc", { team_id: "" })).toBeNull();
    expect(extractIdFields("svc", { team_id: "a b" })).toBeNull();
    expect(extractIdFields("svc", {})).toBeNull();
  });

  it("collects required + optional fields when present", () => {
    const fields = extractIdFields("svc", {
      team_id: "team",
      user_id: "u",
      agent_id: "a",
      task_id: "t",
    });
    expect(fields).toEqual({ service_id: "svc", team_id: "team", user_id: "u", agent_id: "a", task_id: "t" });
  });

  it("omits optional fields when missing or non-string", () => {
    const fields = extractIdFields("svc", { team_id: "team", user_id: "", agent_id: 5, task_id: undefined });
    expect(fields).toEqual({ service_id: "svc", team_id: "team" });
  });

  it("exposes the service id header constant", () => {
    expect(SERVICE_ID_HEADER).toBe("x-tdai-service-id");
  });
});

describe("wrapOk / wrapError", () => {
  it("wraps ok with/without request id", () => {
    expect(wrapOk({ a: 1 })).toEqual({ code: 0, message: "ok", data: { a: 1 } });
    expect(wrapOk({ a: 1 }, "req-1")).toEqual({ code: 0, message: "ok", request_id: "req-1", data: { a: 1 } });
  });

  it("wraps error with/without request id", () => {
    expect(wrapError(400, "bad")).toEqual({ code: 400, message: "bad", data: null });
    expect(wrapError(500, "boom", "r2")).toEqual({ code: 500, message: "boom", request_id: "r2", data: null });
  });
});

describe("toWikiDetail", () => {
  it("maps null fields to null and version to string", () => {
    const d = toWikiDetail(baseWiki());
    expect(d.wiki_id).toBe("wiki-abcdef12");
    expect(d.version).toBe("3");
    expect(d.service_url).toBeNull();
    expect(d.page_count).toBeNull();
  });

  it("keeps populated nullable fields", () => {
    const d = toWikiDetail(
      baseWiki({ service_url: "http://s", summary: "sum", sync_error: "e", owner_user_id: "o", page_count: 7, last_sync_at: "2020-02-02" }),
    );
    expect(d.service_url).toBe("http://s");
    expect(d.summary).toBe("sum");
    expect(d.sync_error).toBe("e");
    expect(d.owner_user_id).toBe("o");
    expect(d.page_count).toBe(7);
    expect(d.last_sync_at).toBe("2020-02-02");
  });
});

describe("toCodeGraphDetail", () => {
  it("parses valid stats_json", () => {
    const d = toCodeGraphDetail(baseCg({ stats_json: '{"files":1,"nodes":2,"edges":3}' }));
    expect(d.stats).toEqual({ files: 1, nodes: 2, edges: 3 });
  });

  it("returns null stats when stats_json null", () => {
    expect(toCodeGraphDetail(baseCg()).stats).toBeNull();
  });

  it("returns null stats on malformed json", () => {
    const d = toCodeGraphDetail(baseCg({ stats_json: "{not json" }));
    expect(d.stats).toBeNull();
  });

  it("maps nullable fields + version string", () => {
    const d = toCodeGraphDetail(baseCg({ commit_hash: "abc", service_url: "http://s", summary: "sum" }));
    expect(d.commit_hash).toBe("abc");
    expect(d.service_url).toBe("http://s");
    expect(d.summary).toBe("sum");
    expect(d.version).toBe("2");
  });
});
