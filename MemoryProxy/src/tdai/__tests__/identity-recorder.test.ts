import { describe, expect, it } from "vitest";
import {
  deriveTdaiIdentity,
  getTdaiIdentity,
  type TdaiIdentitySource,
} from "../identity.js";
import { extractLatestUserMessage, extractUserQueryText, recordTdaiTurn, type TdaiClient } from "../recorder.js";

describe("deriveTdaiIdentity", () => {
  it("derives a full identity from session info", () => {
    const got = deriveTdaiIdentity({
      sessionInfo: {
        team_id: "team1",
        user_id: "user1",
        agent_id: "agent1",
        session_id: "sess1",
        task_id: "task1",
      },
      userKey: "k-123",
    });
    expect(got).toEqual({ teamId: "team1", userId: "user1", agentId: "agent1", sessionId: "sess1", taskId: "task1", userKey: "k-123" });
  });

  it("falls back to userId/sessionKey sources", () => {
    const got = deriveTdaiIdentity({
      sessionInfo: { team_id: "t", agent_id: "a" },
      userId: "u2",
      sessionKey: "sk2",
    });
    expect(got?.userId).toBe("u2");
    expect(got?.sessionId).toBe("sk2");
  });

  it("trims whitespace in string fields", () => {
    const got = deriveTdaiIdentity({ sessionInfo: { team_id: " t ", user_id: " u ", agent_id: " a ", session_id: " s " } });
    expect(got?.teamId).toBe("t");
    expect(got?.userId).toBe("u");
    expect(got?.agentId).toBe("a");
    expect(got?.sessionId).toBe("s");
  });

  it("returns null when any required field missing", () => {
    expect(deriveTdaiIdentity({})).toBeNull();
    expect(deriveTdaiIdentity({ sessionInfo: { team_id: "t" } })).toBeNull();
    expect(deriveTdaiIdentity({ sessionInfo: { user_id: "u", agent_id: "a", session_id: "s", team_id: "" } })).toBeNull();
    expect(deriveTdaiIdentity({ sessionInfo: null, userId: null, sessionKey: null })).toBeNull();
  });
});

describe("getTdaiIdentity", () => {
  it("reads custom.userKey and custom.session", () => {
    const got = getTdaiIdentity({
      userKey: "uk",
      session: { team_id: "t", user_id: "u", agent_id: "a", session_id: "s" },
    });
    expect(got?.userKey).toBe("uk");
    expect(got?.teamId).toBe("t");
  });

  it("returns null for undefined custom", () => {
    expect(getTdaiIdentity(undefined)).toBeNull();
  });
});

describe("extractLatestUserMessage / extractUserQueryText", () => {
  it("skips to the last real user message", () => {
    const got = extractLatestUserMessage([
      { role: "assistant", content: "a" },
      { role: "user", content: [{ type: "text", text: "<additional_data>meta</additional_data>real q" }] },
      { role: "tool", content: "r" },
      { role: "user", content: "Current runtime context. cwd=/x" },
    ]);
    expect(got).toEqual({ role: "user", content: "real q" });
  });

  it("handles array content with p.content fallback", () => {
    const got = extractLatestUserMessage([
      { role: "user", content: [{ type: "text", text: "a" }, { content: "b" }, { type: "image" }, "skip"] },
    ]);
    expect(got).toEqual({ role: "user", content: "a\nb" });
  });

  it("returns null when no usable user message", () => {
    expect(extractLatestUserMessage([{ role: "assistant", content: "a" }])).toBeNull();
    expect(extractLatestUserMessage([{ role: "user", content: "<system-reminder>only</system-reminder>" }])).toBeNull();
    expect(extractLatestUserMessage([])).toBeNull();
    expect(extractLatestUserMessage([{ role: "user", content: 42 }])).toBeNull();
  });

  it("re-exports extractUserQueryText", () => {
    expect(typeof extractUserQueryText).toBe("function");
    expect(extractUserQueryText("<user_query>hi</user_query>")).toBe("hi");
  });
});

describe("recordTdaiTurn", () => {
  const client: TdaiClient = { addConversation: async () => {} };

  it("skips when identity or userMessage missing", async () => {
    await recordTdaiTurn(client, null, { role: "user", content: "x" }, "assistant");
    await recordTdaiTurn(client, { teamId: "t", userId: "u", agentId: "a", sessionId: "s" }, null, "assistant");
    expect(true).toBe(true);
  });

  it("records user message with assistant content when present", async () => {
    let captured: unknown = null;
    const spyClient: TdaiClient = {
      addConversation: async (identity, messages) => {
        captured = { identity, messages };
      },
    };
    await recordTdaiTurn(spyClient, { teamId: "t", userId: "u", agentId: "a", sessionId: "s" }, { role: "user", content: "q" }, "answer ");
    const c = captured as { identity: unknown; messages: unknown[] };
    expect(c.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "answer " },
    ]);
  });

  it("omits empty/whitespace assistant content", async () => {
    let captured: unknown = null;
    const spyClient: TdaiClient = {
      addConversation: async (_identity, messages) => {
        captured = messages;
      },
    };
    await recordTdaiTurn(spyClient, { teamId: "t", userId: "u", agentId: "a", sessionId: "s" }, { role: "user", content: "q" }, "   ");
    expect(captured).toEqual([{ role: "user", content: "q" }]);
  });
});