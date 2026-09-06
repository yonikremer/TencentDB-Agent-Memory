import { describe, expect, it } from "vitest";
import { resolveAgentAdapter } from "../index.js";
import { claudeCodeAdapter } from "../claude-code.js";
import { codebuddyAdapter } from "../codebuddy.js";
import { codexAdapter } from "../codex.js";
import { workbuddyAdapter } from "../workbuddy.js";
import { dshAdapter } from "../dsh.js";
import { opencodeAdapter } from "../opencode.js";
import { piAdapter } from "../pi.js";
import { defaultAdapter } from "../default.js";

describe("resolveAgentAdapter", () => {
  it("resolves every known agent source", () => {
    expect(resolveAgentAdapter("claude-code")).toBe(claudeCodeAdapter);
    expect(resolveAgentAdapter("codebuddy")).toBe(codebuddyAdapter);
    expect(resolveAgentAdapter("codex")).toBe(codexAdapter);
    expect(resolveAgentAdapter("workbuddy")).toBe(workbuddyAdapter);
    expect(resolveAgentAdapter("dsh")).toBe(dshAdapter);
    expect(resolveAgentAdapter("opencode")).toBe(opencodeAdapter);
    expect(resolveAgentAdapter("pi")).toBe(piAdapter);
  });

  it("falls back to default adapter for unknown sources", () => {
    expect(resolveAgentAdapter("cursor")).toBe(defaultAdapter);
    expect(resolveAgentAdapter("")).toBe(defaultAdapter);
  });
});

describe("defaultAdapter", () => {
  it("classifies everything as main", () => {
    expect(defaultAdapter.classifyRequest({})).toBe("main");
  });

  it("extracts text: string passthrough", () => {
    expect(defaultAdapter.extractUserText("hello")).toBe("hello");
    expect(defaultAdapter.extractUserText("")).toBe("");
  });

  it("extracts text: concatenates array text blocks", () => {
    const content = [
      { type: "text", text: "a" },
      { type: "tool_result", content: "x" },
      { type: "text", text: "b" },
      null,
      "not-an-object",
      { type: "image" },
    ];
    expect(defaultAdapter.extractUserText(content)).toBe("a\nb");
  });

  it("extracts text: null for no text blocks / non-array / null", () => {
    expect(defaultAdapter.extractUserText([{ type: "tool_result" }])).toBeNull();
    expect(defaultAdapter.extractUserText(42)).toBeNull();
    expect(defaultAdapter.extractUserText(null)).toBeNull();
    expect(defaultAdapter.extractUserText([])).toBeNull();
  });
});

describe("claudeCodeAdapter", () => {
  it("classifies a fork by cache_control at n-2", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "text", text: "c" }] },
      ],
    };
    expect(claudeCodeAdapter.classifyRequest(body)).toBe("fork");
  });

  it("classifies a main request (marker at n-1)", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: [{ type: "text", text: "b" }] },
        { role: "user", content: [{ type: "text", text: "c", cache_control: { type: "ephemeral" } }] },
      ],
    };
    expect(claudeCodeAdapter.classifyRequest(body)).toBe("main");
  });

  it("classifies sidequery when no marker + empty tools + thinking disabled", () => {
    const body = { messages: [{ role: "user", content: "hi" }], tools: [], thinking: { type: "disabled" } };
    expect(claudeCodeAdapter.classifyRequest(body)).toBe("sidequery");
  });

  it("falls back to main for malformed bodies", () => {
    expect(claudeCodeAdapter.classifyRequest({})).toBe("main");
  });

  it("extracts the last text block", () => {
    const content = [
      { type: "text", text: "<system-reminder>x</system-reminder>" },
      { type: "tool_result", content: "r" },
      { type: "text", text: "real user input" },
    ];
    expect(claudeCodeAdapter.extractUserText(content)).toBe("real user input");
    expect(claudeCodeAdapter.extractUserText("plain")).toBe("plain");
    expect(claudeCodeAdapter.extractUserText(null)).toBeNull();
  });
});

describe("codebuddyAdapter", () => {
  it("classifies as main always", () => {
    expect(codebuddyAdapter.classifyRequest({ tools: [] })).toBe("main");
  });

  it("extracts user query from string content", () => {
    const content = "<user_info>os</user_info><additional_data>t</additional_data><user_query>fix bug</user_query>";
    expect(codebuddyAdapter.extractUserText(content)).toBe("fix bug");
    expect(codebuddyAdapter.extractUserText("bare text")).toBe("bare text");
  });

  it("falls back to default adapter for non-string content", () => {
    expect(codebuddyAdapter.extractUserText([{ type: "text", text: "x" }])).toBe("x");
    expect(codebuddyAdapter.extractUserText(null)).toBeNull();
  });

  it("returns null when wrapper strip leaves nothing", () => {
    expect(codebuddyAdapter.extractUserText("<additional_data>only metadata</additional_data>")).toBeNull();
  });
});

describe("codexAdapter", () => {
  const userMsg = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hello codex" }],
  };

  it("detects aux via path suffix", () => {
    expect(codexAdapter.classifyRequest({}, "/v1/responses/compact")).toBe("auxiliary");
    expect(codexAdapter.classifyRequest({}, "/v1/memories/trace_summarize")).toBe("auxiliary");
    expect(codexAdapter.classifyRequest({}, "/v1/realtime/calls")).toBe("auxiliary");
  });

  it("detects aux via memgen header", () => {
    expect(codexAdapter.classifyRequest({}, "/v1/responses", { "x-openai-memgen-request": "true" })).toBe("auxiliary");
  });

  it("detects aux via client_metadata.thread_source", () => {
    expect(codexAdapter.classifyRequest({ client_metadata: { thread_source: "memory_consolidation" } })).toBe("auxiliary");
    expect(codexAdapter.classifyRequest({ client_metadata: { thread_source: "system" } })).toBe("auxiliary");
  });

  it("treats unknown thread_source as main", () => {
    expect(codexAdapter.classifyRequest({ client_metadata: { thread_source: "user" } })).toBe("main");
    expect(codexAdapter.classifyRequest({}, "/v1/responses")).toBe("main");
  });

  it("extracts last user input_text joined by newline", () => {
    const input = [
      { type: "function_call", name: "shell" },
      { type: "reasoning", encrypted_content: "..." },
      userMsg,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "again" }, { type: "input_image" }, { type: "input_text", text: "!!" }] },
    ];
    expect(codexAdapter.extractUserText(input)).toBe("again\n!!");
  });

  it("extract returns null when no user input_text", () => {
    expect(codexAdapter.extractUserText([{ type: "message", role: "user", content: [{ type: "input_image" }] }])).toBeNull();
    expect(codexAdapter.extractUserText("not-array")).toBeNull();
    expect(codexAdapter.extractUserText([])).toBeNull();
  });
});

describe("workbuddyAdapter", () => {
  it("detects aux via path / header / thread_source", () => {
    expect(workbuddyAdapter.classifyRequest({}, "/v1/responses/compact")).toBe("auxiliary");
    expect(workbuddyAdapter.classifyRequest({}, "/v1/responses", { "x-openai-memgen-request": "true" })).toBe("auxiliary");
    expect(workbuddyAdapter.classifyRequest({ client_metadata: { thread_source: "memory_consolidation" } })).toBe("auxiliary");
  });

  it("treats unknown as main", () => {
    expect(workbuddyAdapter.classifyRequest({}, "/v1/responses")).toBe("main");
    expect(workbuddyAdapter.classifyRequest({ client_metadata: { thread_source: "other" } }, "/x", { "x-openai-memgen-request": "false" })).toBe("main");
  });

  it("extracts string content via user-query strip", () => {
    expect(workbuddyAdapter.extractUserText("<user_query>wb query</user_query>")).toBe("wb query");
    expect(workbuddyAdapter.extractUserText("bare")).toBe("bare");
  });

  it("extracts responses-api input[] content", () => {
    const input = [
      { type: "function_call", name: "f" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "wb!" }] },
    ];
    expect(workbuddyAdapter.extractUserText(input)).toBe("wb!");
    expect(workbuddyAdapter.extractUserText([])).toBeNull();
    expect(workbuddyAdapter.extractUserText(42)).toBeNull();
    expect(defaultAdapter.extractUserText(["x"])).toBeNull();
  });
});

describe("dshAdapter", () => {
  it("detects compact header as auxiliary", () => {
    expect(dshAdapter.classifyRequest({}, undefined, { "x-deepseek-harness-compact": "1" })).toBe("auxiliary");
  });

  it("detects title-gen body shape as auxiliary", () => {
    const body = {
      tools: [],
      thinking: { type: "disabled" },
      max_tokens: 64,
      messages: [{ role: "system", content: "Create a concise title for an AI coding-assistant session from the supplied human messages." }],
    };
    expect(dshAdapter.classifyRequest(body)).toBe("auxiliary");
  });

  it("rejects title-gen when a condition is missing", () => {
    const base = {
      tools: [],
      thinking: { type: "disabled" },
      max_tokens: 64,
      messages: [{ role: "system", content: "Create a concise title for an AI coding-assistant session xy" }],
    };
    expect(dshAdapter.classifyRequest({ ...base, tools: [{ name: "t" }] })).toBe("main");
    expect(dshAdapter.classifyRequest({ ...base, thinking: { type: "enabled" } })).toBe("main");
    expect(dshAdapter.classifyRequest({ ...base, max_tokens: 200 })).toBe("main");
    expect(dshAdapter.classifyRequest({ ...base, max_tokens: "64" })).toBe("main");
    expect(dshAdapter.classifyRequest({ ...base, messages: [] })).toBe("main");
    expect(dshAdapter.classifyRequest({ ...base, messages: [{ role: "user", content: "x" }] })).toBe("main");
    expect(dshAdapter.classifyRequest({ ...base, messages: [{ role: "system", content: "other" }] })).toBe("main");
    expect(dshAdapter.classifyRequest({})).toBe("main");
  });

  it("extracts string user text only", () => {
    expect(dshAdapter.extractUserText("dsh prompt")).toBe("dsh prompt");
    expect(dshAdapter.extractUserText("")).toBeNull();
    expect(dshAdapter.extractUserText([{ type: "text", text: "x" }])).toBeNull();
  });
});

describe("opencodeAdapter", () => {
  it("classifies as main", () => {
    expect(opencodeAdapter.classifyRequest({})).toBe("main");
  });

  it("extracts string / falls back for arrays", () => {
    expect(opencodeAdapter.extractUserText("oc text")).toBe("oc text");
    expect(opencodeAdapter.extractUserText("<user_query>q</user_query>")).toBe("q");
    expect(opencodeAdapter.extractUserText([{ type: "text", text: "arr" }])).toBe("arr");
    expect(opencodeAdapter.extractUserText(5)).toBeNull();
  });
});

describe("piAdapter", () => {
  it("classifies as main", () => {
    expect(piAdapter.classifyRequest({})).toBe("main");
  });

  it("extracts string content", () => {
    expect(piAdapter.extractUserText("pi text")).toBe("pi text");
    expect(piAdapter.extractUserText("")).toBeNull();
    expect(piAdapter.extractUserText([{ type: "text", text: "block" }])).toBe("block");
  });
});