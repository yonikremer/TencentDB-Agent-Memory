import { describe, expect, it } from "vitest";
import { classifyCcRequest, findLastCacheControlIndex } from "../cc-request-classifier.js";

describe("findLastCacheControlIndex", () => {
  it("finds the cache_control marker inside content blocks", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }] },
    ];
    expect(findLastCacheControlIndex(msgs)).toBe(1);
  });

  it("returns -1 when no marker", () => {
    expect(findLastCacheControlIndex([{ role: "user" }, { role: "assistant", content: "plain" }])).toBe(-1);
    expect(findLastCacheControlIndex([])).toBe(-1);
    expect(findLastCacheControlIndex([{}, null as unknown as object])).toBe(-1);
  });
});

describe("classifyCcRequest", () => {
  function msg(role: string, cache?: boolean): unknown {
    return {
      role,
      content: [{ type: "text", text: role, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) }],
    };
  }

  it("classifies fork when marker is at n-2", () => {
    const body = { messages: [msg("user"), msg("assistant", true), msg("user")] };
    expect(classifyCcRequest(body)).toBe("fork");
    // exactly two messages with marker on the first => n-2 == 0
    expect(classifyCcRequest({ messages: [msg("user", true), msg("assistant")] })).toBe("fork");
  });

  it("classifies main when marker at n-1 or other positions", () => {
    const body = { messages: [msg("user"), msg("assistant"), msg("user", true)] };
    expect(classifyCcRequest(body)).toBe("main");
    expect(classifyCcRequest({ messages: [msg("user", true)] })).toBe("main");
  });

  it("filters out system messages before marker-position logic", () => {
    // system first, user+assistant w/ marker at index 2 of filtered => n-2 => fork
    const body = {
      messages: [
        { role: "system", content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] },
        msg("user"),
        msg("assistant", true),
        msg("user"),
      ],
    };
    // after filtering system: [user, assistant(marker), user] => marker at 1 == n-2 (n=3)
    expect(classifyCcRequest(body)).toBe("fork");
  });

  it("classifies sidequery when no marker + empty tools + thinking disabled", () => {
    const body = { messages: [msg("user")], tools: [], thinking: { type: "disabled" } };
    expect(classifyCcRequest(body)).toBe("sidequery");
    expect(classifyCcRequest({ messages: [] as unknown[], tools: [], thinking: { type: "disabled" } })).toBe("sidequery");
  });

  it("treats non-array tools as empty", () => {
    const body = { messages: [msg("user")], tools: "none", thinking: { type: "disabled" } };
    expect(classifyCcRequest(body)).toBe("sidequery");
  });

  it("falls back to main when only one of tools/thinking matches", () => {
    expect(classifyCcRequest({ messages: [msg("user")], tools: [], thinking: { type: "enabled" } })).toBe("main");
    expect(classifyCcRequest({ messages: [msg("user")], tools: [{ name: "t" }], thinking: { type: "disabled" } })).toBe("main");
  });

  it("falls back to main for malformed bodies", () => {
    expect(classifyCcRequest({})).toBe("main");
    expect(classifyCcRequest({ messages: "nope" })).toBe("main");
    expect(classifyCcRequest({ messages: [{ role: "system" }] })).toBe("main");
  });
});