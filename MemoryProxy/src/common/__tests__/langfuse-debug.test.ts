import { describe, expect, it } from "vitest";
import { buildLangfuseInputChat, buildRequestDebugMetadata } from "../langfuse-debug.js";

describe("buildLangfuseInputChat", () => {
  it("returns original messages when debug", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "x" }] }];
    expect(buildLangfuseInputChat(messages, true, () => [])).toBe(messages);
  });

  it("uses fallback when not debug", () => {
    const fallback = (m: unknown[]) => m.map(() => "flat");
    expect(buildLangfuseInputChat([{ role: "user" }], false, fallback)).toEqual(["flat"]);
  });
});

describe("buildRequestDebugMetadata", () => {
  it("returns empty object when debug is false", () => {
    expect(buildRequestDebugMetadata({ debug: false, body: {} })).toEqual({});
  });

  it("extracts top-level body fields", () => {
    const out = buildRequestDebugMetadata({
      debug: true,
      body: {
        model: "claude-3-5",
        stream: true,
        max_tokens: 100,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 10,
        thinking: { type: "enabled" },
        stop_sequences: ["a", "b"],
        system: "sys prompt",
        messages: [{ role: "user" }],
        tools: [{ name: "t1", description: "d1" }],
        metadata: { user_id: "u" },
        custom_extra: "yes",
      },
      agentSource: "claude-code",
      requestKind: "main",
      spaceId: "s1",
      turnSeq: 3,
      requestPath: "/v1/messages",
      protocol: "anthropic",
    });
    expect(out.model).toBe("claude-3-5");
    expect(out.stream).toBe(true);
    expect(out.max_tokens).toBe(100);
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
    expect(out.top_k).toBe(10);
    expect(out.thinking_type).toBe("enabled");
    expect(out.stop_sequences_len).toBe(2);
    expect(out.system_len).toBe(10);
    expect(out.messages_len).toBe(1);
    expect(out.tools_len).toBe(1);
    expect(out.agent_source).toBe("claude-code");
    expect(out.request_kind).toBe("main");
    expect(out.space_id).toBe("s1");
    expect(out.turn_seq).toBe(3);
    expect(out.request_path).toBe("/v1/messages");
    expect(out.protocol).toBe("anthropic");
  });

  it("handles array system, openai stop, and tools with function wrapper", () => {
    const out = buildRequestDebugMetadata({
      debug: true,
      body: {
        system: [{ type: "text", text: "abc" }],
        stop: ["x"],
        tools: [{ function: { name: "fn", description: "desc" } }, null],
      },
    });
    expect(out.system_len).toBe(3);
    expect(out.stop_sequences_len).toBe(1);
    expect(out.tools_len).toBe(2);
    expect((out.tools_summary as Array<{ name: string; desc: string }>)[0]).toEqual({ name: "fn", desc: "desc" });
  });

  it("captures cache_control marker index and truncates long fields", () => {
    const long = "x".repeat(500);
    const out = buildRequestDebugMetadata({
      debug: true,
      body: {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "b", cache_control: {} }] },
        ],
        tools: [{ name: long, description: long }],
      },
    });
    expect(out.cache_control_marker_idx).toBe(0);
    const summary = (out.tools_summary as Array<{ name: string; desc: string }>)[0];
    expect(summary.name.length).toBeLessThan(300);
  });

  it("captures whitelisted headers and skips sensitive/other headers", () => {
    const out = buildRequestDebugMetadata({
      debug: true,
      body: {},
      headers: {
        authorization: "Bearer x",
        "x-api-key": "k",
        cookie: "c=1",
        "x-conversation-id": "cid",
        "codebuddy-mem": "1",
        host: "localhost",
      },
    });
    expect(out["header_x-conversation-id"]).toBe("cid");
    expect(out["header_codebuddy-mem"]).toBe("1");
    expect(out.header_authorization).toBeUndefined();
    expect(out.header_host).toBeUndefined();
  });

  it("does not crash on weird body values", () => {
    const out = buildRequestDebugMetadata({
      debug: true,
      body: {
        messages: "nope",
        system: 5,
        tools: "not-array",
        thinking: "x",
      } as unknown as Record<string, unknown>,
      headers: { "x-a": "b" },
    });
    expect(out.messages_len).toBe(0);
    expect(out.tools_len).toBeUndefined();
    expect(out["header_x-a"]).toBe("b");
  });

  it("excludes cache_control when messages empty", () => {
    const out = buildRequestDebugMetadata({ debug: true, body: {} });
    expect(out.cache_control_marker_idx).toBeUndefined();
    expect(out.body_metadata).toBeUndefined();
    expect(out.body_extra_keys).toBeUndefined();
  });
});