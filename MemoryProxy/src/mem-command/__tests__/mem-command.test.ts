import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../routes/session-refresh.js", () => ({
  refreshSessionCache: vi.fn(),
}));
vi.mock("../../routes/session-force-archive.js", () => ({
  forceArchiveSkill: vi.fn(),
}));
vi.mock("../../routes/session-task.js", () => ({
  confirmPendingTaskAction: vi.fn(),
  cancelPendingTaskAction: vi.fn(),
  createTaskFromSession: vi.fn(),
  updateTaskFromSession: vi.fn(),
}));

import { refreshSessionCache } from "../../routes/session-refresh.js";
import { forceArchiveSkill } from "../../routes/session-force-archive.js";
import { confirmPendingTaskAction, cancelPendingTaskAction, createTaskFromSession, updateTaskFromSession } from "../../routes/session-task.js";
import { parseMemCommand, parseCommandFromText } from "../parser.js";
import { isSessionResetCommand } from "../pre-intercept.js";
import { makePendingKey, setPending, getPending, clearPending, _resetPendingStoreForTests } from "../pending-store.js";
import { buildMemResponse, buildAnthropicResponse, buildAnthropicStreamResponse, buildOpenAIResponse, buildOpenAIStreamResponse, buildResponsesResponse, buildResponsesStreamResponse } from "../response-builder.js";
import { truncateArgs, extractSimpleMessages } from "../utils.js";
import { executeHelp, getHelpText } from "../commands/help.js";
import { executeSync } from "../commands/sync.js";
import { executeCreateSkill } from "../commands/create-skill.js";
import { executeCreateTask } from "../commands/create-task.js";
import { executeUpdateTask } from "../commands/update-task.js";
import { executeSessionReset } from "../commands/session-reset.js";
import { isMemCommandAllowed, executeMemCommand } from "../index.js";
import { generateTaskDraft, extractJsonObject } from "../task-draft-generator.js";

const mockRefresh = vi.mocked(refreshSessionCache);
const mockForceArchive = vi.mocked(forceArchiveSkill);
const mockConfirm = vi.mocked(confirmPendingTaskAction);
const mockCancel = vi.mocked(cancelPendingTaskAction);
const mockCreateTask = vi.mocked(createTaskFromSession);
const mockUpdateTask = vi.mocked(updateTaskFromSession);

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: "sess-1",
    agentSource: "codebuddy",
    config: { memCommand: {} },
    spaceId: "sp",
    userId: "u1",
    apiKey: "k",
    sessionInfo: { team_id: "t1" },
    protocol: "openai",
    stream: false,
    args: "",
    bodyMessages: [],
    ...overrides,
  } as never;
}

describe("parseCommandFromText", () => {
  it("parses commands and args", () => {
    expect(parseCommandFromText("mem:sync")).toEqual({ command: "sync", args: "", rawMessage: "mem:sync" });
    expect(parseCommandFromText("  Mem:Create-Skill  highlight db steps ")).toEqual({
      command: "create-skill",
      args: "highlight db steps",
      rawMessage: "Mem:Create-Skill  highlight db steps",
    });
    expect(parseCommandFromText("mem: help")).toEqual({ command: "help", args: "", rawMessage: "mem: help" });
  });

  it("rejects non mem: texts and empty commands", () => {
    expect(parseCommandFromText("hello mem:sync")).toBeNull();
    expect(parseCommandFromText("")).toBeNull();
    expect(parseCommandFromText("mem:")).toBeNull();
    expect(parseCommandFromText("   ")).toBeNull();
  });

  it("rejects args on strict commands", () => {
    expect(parseCommandFromText("mem:help please")).toBeNull();
    expect(parseCommandFromText("mem:sync now")).toBeNull();
    expect(parseCommandFromText("mem:session-reset x")).toBeNull();
  });

  it("passes through for unknown commands regardless of args", () => {
    expect(parseCommandFromText("mem:foo bar baz")).toEqual({ command: "foo", args: "bar baz", rawMessage: "mem:foo bar baz" });
  });
});

describe("parseMemCommand", () => {
  it("returns null for missing messages", () => {
    expect(parseMemCommand({}, "claude-code")).toBeNull();
  });

  it("recognizes command from last user message", () => {
    const body = { messages: [{ role: "assistant", content: "hi" }, { role: "user", content: "mem:sync" }] };
    expect(parseMemCommand(body, "codebuddy")?.command).toBe("sync");
  });

  it("handles checkFirst option", () => {
    const body = { messages: [{ role: "user", content: "mem:help" }, { role: "user", content: "no command here" }] };
    expect(parseMemCommand(body, "codebuddy", { checkFirst: true })?.command).toBe("help");
    expect(parseMemCommand(body, "codebuddy")).toBeNull();
  });

  it("works with array content via adapter", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }, { type: "text", text: "mem:create-skill fix bug" }] }],
    };
    expect(parseMemCommand(body, "claude-code")?.command).toBe("create-skill");
  });

  it("returns null when last message is not user", () => {
    expect(parseMemCommand({ messages: [{ role: "assistant", content: "x" }] }, "codebuddy")).toBeNull();
  });
});

describe("isSessionResetCommand", () => {
  it("recognizes session-reset in messages format", () => {
    expect(isSessionResetCommand({ messages: [{ role: "user", content: "mem:session-reset" }] }, "codebuddy")).toBe(true);
    expect(isSessionResetCommand({ messages: [{ role: "user", content: "mem:sync" }] }, "codebuddy")).toBe(false);
  });

  it("recognizes session-reset in input[] format only when last item is a user message", () => {
    expect(isSessionResetCommand({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "mem:session-reset" }] }] }, "codex")).toBe(true);
    expect(isSessionResetCommand({ input: [{ type: "function_call_output", output: "x" }] }, "codex")).toBe(false);
    expect(isSessionResetCommand({ input: [] }, "codex")).toBe(false);
    expect(isSessionResetCommand({ input: [{ type: "message", role: "user", content: "not-array" }] }, "codex")).toBe(false);
  });

  it("returns false on missing/wrong shapes gracefully", () => {
    expect(isSessionResetCommand(null, "codebuddy")).toBe(false);
    expect(isSessionResetCommand({}, "codebuddy")).toBe(false);
    expect(isSessionResetCommand({ messages: [] }, "codebuddy")).toBe(false);
    expect(isSessionResetCommand({ messages: [{ role: "assistant" }] }, "codebuddy")).toBe(false);
    expect(isSessionResetCommand({ messages: [{ role: "user", content: null }] }, "codebuddy")).toBe(false);
  });
});

describe("pending-store", () => {
  beforeEach(() => _resetPendingStoreForTests());

  it("round-trips pending entries with TTL", () => {
    const key = makePendingKey({ team_id: "t", agent_id: "a", session_id: "s" });
    expect(key).toBe("t:a:s");
    expect(makePendingKey({})).toBe("-:-:-");
    const payload = { kind: "create" as const, draft: { title: "T", description: "D" }, currentTaskId: "old" };
    setPending(key, payload, 60_000);
    expect(getPending(key)).toEqual(payload);
    expect(clearPending(key)).toBe(true);
    expect(getPending(key)).toBeNull();
    expect(clearPending(key)).toBe(false);
  });

  it("expires entries lazily", () => {
    setPending("k", { kind: "update" as const, draft: { taskId: "x", description: "d" } }, -1);
    expect(getPending("k")).toBeNull();
  });
});

describe("response-builder", () => {
  it("builds each protocol response shape", async () => {
    const anthropic = buildAnthropicResponse("hello", "rid", true);
    expect(anthropic.headers.get("content-type")).toContain("application/json");
    const json = await anthropic.json() as { content: unknown[]; type: string };
    expect(json.type).toBe("message");
    expect(json.content).toHaveLength(2);

    const anthropicNoThink = await buildAnthropicResponse("hi", "r2").json() as { content: unknown[] };
    expect(anthropicNoThink.content).toHaveLength(1);

    const stream = buildAnthropicStreamResponse("txt", "r3", true);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const body = await stream.text();
    expect(body).toContain("message_start");
    expect(body).toContain("thinking_delta");
    expect(body).toContain("text_delta");

    const streamNoThink = await buildAnthropicStreamResponse("txt", "r4").text();
    expect(streamNoThink).not.toContain("thinking");

    const openai = await buildOpenAIResponse("o", "r5").json() as { object: string };
    expect(openai.object).toBe("chat.completion");
    const openaiStream = await buildOpenAIStreamResponse("o", "r6").text();
    expect(openaiStream).toContain("[DONE]");

    const resp = await buildResponsesResponse("rr", "r7").json() as { object: string; output: Array<{ type: string }> };
    expect(resp.object).toBe("response");
    expect(resp.output[0].type).toBe("message");
    const respStream = await buildResponsesStreamResponse("rr", "r8").text();
    expect(respStream).toContain("response.completed");
    expect(respStream).toContain("response.created");
  });

  it("buildMemResponse dispatches on protocol/stream", async () => {
    const a = buildMemResponse("x", { protocol: "anthropic", stream: false });
    expect(a.headers.get("content-type")).toContain("application/json");
    const b = buildMemResponse("x", { protocol: "anthropic", stream: true });
    expect(b.headers.get("content-type")).toBe("text/event-stream");
    const c = buildMemResponse("x", { protocol: "responses", stream: false });
    expect((await c.json() as { object: string }).object).toBe("response");
    const d = buildMemResponse("x", { protocol: "responses", stream: true });
    expect((await d.text()).includes("response.created")).toBe(true);
    const e = buildMemResponse("x", { protocol: "openai", stream: false });
    expect((await e.json() as { object: string }).object).toBe("chat.completion");
    const f = buildMemResponse("x", { protocol: "openai", stream: true });
    expect((await f.text()).includes("[DONE]")).toBe(true);
    const g = buildMemResponse("x", { protocol: "openai", stream: true, requestId: "custom", thinking: true });
    expect(g.headers.get("x-request-id")).toBe("custom");
  });
});

describe("mem-command utils", () => {
  it("truncateArgs collapses whitespace and truncates", () => {
    expect(truncateArgs("a  b\nc")).toBe("a b c");
    expect(truncateArgs("x".repeat(50), 10)).toBe("xxxxxxxxxx...");
    expect(truncateArgs("")).toBe("");
    expect(truncateArgs(null)).toBe("");
    expect(truncateArgs("   ")).toBe("");
    expect(truncateArgs("short", 40)).toBe("short");
  });

  it("extractSimpleMessages handles all three protocol shapes", () => {
    const out = extractSimpleMessages([
      { role: "user", content: "plain" },
      { role: "user", content: [{ type: "text", text: "a" }, { type: "tool_use", name: "x" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "resp" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "in" }] },
      { type: "function_call", name: "f" },
      { role: "system", content: "sys" },
      { role: "user", content: "" },
      { role: "user", content: [] },
      null,
      "weird",
      { role: "other", content: "skip" },
      { role: "user", content: 42 },
    ]);
    expect(out).toEqual([
      { role: "user", content: "plain" },
      { role: "user", content: "a" },
      { role: "assistant", content: "resp" },
      { role: "user", content: "in" },
      { role: "system", content: "sys" },
    ]);
    expect(extractSimpleMessages("nope")).toEqual([]);
  });
});

describe("mem: commands", () => {
  const base = () => ctx();

  it("help returns help text", async () => {
    const result = await executeHelp(base());
    expect(result.success).toBe(true);
    expect(result.messageText).toContain("mem:sync");
    expect(getHelpText()).toContain("mem:create-task");
    expect(result.response.status).toBe(200);
  });

  it("sync: unbound session short-circuits", async () => {
    const result = await executeSync(ctx({ sessionInfo: {} }));
    expect(result.success).toBe(false);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("sync: success and failure paths", async () => {
    mockRefresh.mockResolvedValueOnce({
      success: true, refreshed: ["a"], skipped: [], agentRefreshed: true, taskRefreshed: false, tookMs: 12, error: undefined,
    });
    const ok = await executeSync(base());
    expect(ok.success).toBe(true);
    expect(ok.messageText).toContain("took 12ms");
    expect((ok.data as { refreshed: string[] }).refreshed).toEqual(["a"]);

    mockRefresh.mockResolvedValueOnce({ success: false, error: "boom", refreshed: [], skipped: [], agentRefreshed: false, taskRefreshed: false, tookMs: 1 });
    const fail = await executeSync(base());
    expect(fail.success).toBe(false);
    expect(fail.messageText).toContain("boom");
  });

  it("create-skill: empty / ok / failed", async () => {
    mockForceArchive.mockResolvedValueOnce({ success: false, error: "err1", status: "empty", taskId: undefined, archiveKey: undefined });
    const failed = await executeCreateSkill(base());
    expect(failed.success).toBe(false);
    expect(failed.messageText).toContain("err1");

    mockForceArchive.mockResolvedValueOnce({ success: true, status: "empty", taskId: undefined, archiveKey: undefined, error: undefined });
    const empty = await executeCreateSkill(base());
    expect(empty.success).toBe(true);
    expect(empty.messageText).toContain("nothing to archive");

    mockForceArchive.mockResolvedValueOnce({ success: true, status: "archived", taskId: "t1", archiveKey: "k1", error: undefined });
    const ok = await executeCreateSkill(ctx({ args: "my reason" }));
    expect(ok.success).toBe(true);
    expect(ok.messageText).toContain("successfully archived");
    expect((ok.data as { status: string }).status).toBe("archived");
  });

  it("create-task: confirm / cancel / no messages / pending / direct", async () => {
    mockConfirm.mockResolvedValueOnce({ success: false, noPending: true, taskId: undefined, previousTaskId: undefined, title: "", description: "", status: undefined, error: undefined });
    const noPending = await executeCreateTask(ctx({ args: "confirm" }));
    expect(noPending.success).toBe(false);
    expect((noPending.data as { reason: string }).reason).toBe("no_pending");

    mockConfirm.mockResolvedValueOnce({
      success: false, noPending: false, error: "db fail", taskId: undefined, previousTaskId: undefined, title: "", description: "", status: undefined,
    });
    const createFailed = await executeCreateTask(ctx({ args: "confirm" }));
    expect(createFailed.success).toBe(false);

    mockConfirm.mockResolvedValueOnce({
      success: true, noPending: false, taskId: "new-1", previousTaskId: "old-1", title: "T", description: "D", status: "running", error: undefined,
    });
    const confirmed = await executeCreateTask(ctx({ args: "CONFIRM" }));
    expect(confirmed.success).toBe(true);
    expect(confirmed.messageText).toContain("Unbound from previous Task `old-1`");

    mockCancel.mockResolvedValueOnce({ success: false, cancelled: false, error: "x" });
    const cancelFail = await executeCreateTask(ctx({ args: "cancel" }));
    expect(cancelFail.success).toBe(false);

    mockCancel.mockResolvedValueOnce({ success: true, cancelled: true, error: undefined });
    const cancelled = await executeCreateTask(ctx({ args: "cancel" }));
    expect(cancelled.success).toBe(true);
    expect(cancelled.messageText).toContain("Cancelled");

    const noMsgs = await executeCreateTask(base());
    expect(noMsgs.success).toBe(false);
    expect((noMsgs.data as { reason: string }).reason).toBe("no_recent_messages");

    mockCreateTask.mockResolvedValueOnce({ success: false, error: "llm down" });
    const fail = await executeCreateTask(ctx({ bodyMessages: [{ role: "user", content: "x" }] }));
    expect(fail.success).toBe(false);

    mockCreateTask.mockResolvedValueOnce({
      success: true,
      pending: { kind: "create", draftTitle: "DT", draftDescription: "DD", currentTaskId: "ct", currentTaskTitle: "CTT" },
      taskId: undefined, title: "", description: "", status: undefined, error: undefined,
    });
    const pending = await executeCreateTask(ctx({ bodyMessages: [{ role: "user", content: "x" }], args: "locked title" }));
    expect((pending.data as { reason: string }).reason).toBe("pending");
    expect(pending.messageText).toContain("CTT");

    mockCreateTask.mockResolvedValueOnce({
      success: true, taskId: "t9", title: "Truncated-title-".repeat(4), description: "", status: "running", error: undefined, pending: undefined,
    });
    const direct = await executeCreateTask(ctx({ bodyMessages: [{ role: "user", content: "x" }] }));
    expect(direct.success).toBe(true);
    expect(direct.messageText).toContain("(Empty)");
  });

  it("update-task: branches", async () => {
    mockConfirm.mockResolvedValueOnce({ success: false, noPending: true, taskId: undefined, title: "", description: "", status: undefined, error: undefined });
    const noPending = await executeUpdateTask(ctx({ args: "confirm" }));
    expect((noPending.data as { reason: string }).reason).toBe("no_pending");

    mockConfirm.mockResolvedValueOnce({ success: true, noPending: false, taskId: "u1", title: "T2", description: "D2", status: "running", error: undefined });
    const ok = await executeUpdateTask(ctx({ args: "confirm" }));
    expect(ok.success).toBe(true);

    mockCancel.mockResolvedValueOnce({ success: true, cancelled: false, error: undefined });
    const none = await executeUpdateTask(ctx({ args: "cancel" }));
    expect(none.messageText).toContain("No pending");

    const noMsgs = await executeUpdateTask(ctx({ args: "" }));
    expect(noMsgs.success).toBe(false);
    expect((noMsgs.data as { reason: string }).reason).toBe("no_recent_messages");

    mockUpdateTask.mockResolvedValueOnce({ success: false, error: "no task bound" });
    const unbound = await executeUpdateTask(ctx({ bodyMessages: [{ role: "user", content: "x" }] }));
    expect((unbound.data as { reason: string }).reason).toBe("no_task_bound");

    mockUpdateTask.mockResolvedValueOnce({ success: false, error: "not_creator" });
    const crossUser = await executeUpdateTask(ctx({ bodyMessages: [{ role: "user", content: "x" }] }));
    expect((crossUser.data as { reason: string }).reason).toBe("not_creator");

    mockUpdateTask.mockResolvedValueOnce({ success: false, error: "some error" });
    const err = await executeUpdateTask(ctx({ bodyMessages: [{ role: "user", content: "x" }] }));
    expect(err.success).toBe(false);

    mockUpdateTask.mockResolvedValueOnce({ success: true, noUpdateNeeded: true, taskId: "u9", pending: undefined, title: "", description: "", status: undefined, error: undefined });
    const noUpdate = await executeUpdateTask(ctx({ bodyMessages: [{ role: "user", content: "x" }] }));
    expect((noUpdate.data as { reason: string }).reason).toBe("no_update_needed");

    mockUpdateTask.mockResolvedValueOnce({
      success: true,
      pending: { kind: "update", taskId: "u1", draftDescription: "new desc", statusSuggestion: "completed", currentTitle: "CT", currentStatus: "running" },
      taskId: undefined, title: "", description: "", status: undefined, error: undefined,
    });
    const pending = await executeUpdateTask(ctx({ bodyMessages: [{ role: "user", content: "x" }], args: "direct description" }));
    expect(pending.messageText).toContain("update preview");

    mockUpdateTask.mockResolvedValueOnce({ success: true, taskId: "u2", pending: undefined, noUpdateNeeded: false, title: "keep", description: "d", status: "running", error: undefined });
    const fallback = await executeUpdateTask(ctx({ bodyMessages: [{ role: "user", content: "x" }] }));
    expect(fallback.messageText).toContain("Task unchanged");
  });

  it("session-reset: intercepts and resets state", async () => {
    const result = await executeSessionReset(base());
    expect(result.success).toBe(true);
    expect(result.messageText).toContain("Reset complete");
    expect((result.data as { old_status: string }).old_status).toBe("uninitialized");
    const streamed = await executeSessionReset(ctx({ protocol: "anthropic", stream: true, sessionInfo: { team_id: "t" } }));
    expect(streamed.response.headers.get("content-type")).toBe("text/event-stream");
  });
});

describe("mem-command index", () => {
  it("isMemCommandAllowed gates by config", () => {
    const cfgOff = { enabled: false, allowedCommands: [] };
    expect(isMemCommandAllowed(cfgOff, "help")).toBe(false);
    const cfgAll = { enabled: true, allowedCommands: [] };
    expect(isMemCommandAllowed(cfgAll, "anything")).toBe(true);
    const cfgList = { enabled: true, allowedCommands: ["sync"] };
    expect(isMemCommandAllowed(cfgList, "sync")).toBe(true);
    expect(isMemCommandAllowed(cfgList, "help")).toBe(false);
    expect(isMemCommandAllowed(cfgList, "session-reset")).toBe(true);
  });

  it("executeMemCommand handles unknown commands", async () => {
    const unknown = await executeMemCommand({ command: "wat", args: "", rawMessage: "mem:wat" }, ctx());
    expect(unknown.success).toBe(false);
    expect(unknown.messageText).toContain("Unknown command");
    const unknown2 = await executeMemCommand({ command: "wat2", args: "", rawMessage: "mem:wat2" }, ctx());
    expect(unknown2.success).toBe(false);
  });

  it("dispatches to help", async () => {
    const r = await executeMemCommand({ command: "help", args: "", rawMessage: "mem:help" }, ctx());
    expect(r.success).toBe(true);
    expect(r.messageText).toContain("Supported mem: Commands");
  });
});

describe("task-draft-generator", () => {
  const cfg = { enabled: true, model: "m", url: "http://llm", apiKey: "k", timeoutMs: 3000 };

  afterEach(() => vi.unstubAllGlobals());

  function stubFetchOnce(payload: unknown, status = 200) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status })));
  }

  it("disabled config short-circuits", async () => {
    const r = await generateTaskDraft({ ...cfg, enabled: false }, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(r.ok).toBe(false);
  });

  it("validates inputs", async () => {
    const noTask = await generateTaskDraft(cfg, { mode: "update", recentMessages: [{ role: "user", content: "x" }] });
    expect(noTask.ok).toBe(false);
    const noMsgs = await generateTaskDraft(cfg, { mode: "create", recentMessages: [] });
    expect(noMsgs.ok).toBe(false);
  });

  it("creates a task draft from LLM JSON", async () => {
    stubFetchOnce({
      choices: [{ message: { content: "{\"title\":\"Fix auth\",\"description\":\"background: x; goal: y; constraint: z\",\"suggestedStatus\":\"running\"}" }, finish_reason: "stop" }],
      usage: { completion_tokens: 40 },
    });
    const r = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "please fix auth" }], hint: "focus on tests" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.title).toBe("Fix auth");
      expect(r.changed).toBe(true);
    }
  });

  it("locked title mode only parses description", async () => {
    stubFetchOnce({
      choices: [{ message: { content: "{\"description\":\"desc here\"}" }, finish_reason: "stop" }],
      usage: {},
    });
    const r = await generateTaskDraft(cfg, { mode: "create", lockedTitle: "Locked", recentMessages: [{ role: "user", content: "x" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe("Locked");
  });

  it("update mode keeps current task when changed=false", async () => {
    stubFetchOnce({ choices: [{ message: { content: "{\"changed\": false}" }, finish_reason: "stop" }], usage: {} });
    const r = await generateTaskDraft(cfg, {
      mode: "update",
      currentTask: { title: "T", description: "D", status: "running" },
      recentMessages: [{ role: "user", content: "nothing new" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.description).toBe("D");
    }
  });

  it("strips command keywords from title", async () => {
    stubFetchOnce({
      choices: [{ message: { content: "{\"title\":\"Fix mem:create-task JSON parse failure and add retry logic here\",\"description\":\"d\",\"suggestedStatus\":\"running\"}" }, finish_reason: "stop" }],
      usage: {},
    });
    const r = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title.length).toBeLessThanOrEqual(40);
  });

  it("handles LLM failures: non-ok status, fetch throw, bad json, no choices, empty content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    const httpFail = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(httpFail.ok).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net fail"); }));
    const netFail = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(netFail.ok).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const notJson = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(notJson.ok).toBe(false);

    stubFetchOnce({ choices: [] });
    const noChoices = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(noChoices.ok).toBe(false);

    stubFetchOnce({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
    const emptyContent = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(emptyContent.ok).toBe(false);
  });

  it("handles unparseable and non-object LLM output", async () => {
    stubFetchOnce({ choices: [{ message: { content: "no json here" }, finish_reason: "stop" }], usage: {} });
    const bad = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(bad.ok).toBe(false);

    stubFetchOnce({ choices: [{ message: { content: "[\"array\"]" }, finish_reason: "stop" }], usage: {} });
    const arr = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(arr.ok).toBe(false);
  });

  it("handles missing title/description fields", async () => {
    stubFetchOnce({ choices: [{ message: { content: "{\"suggestedStatus\":\"x\"}" }, finish_reason: "stop" }], usage: {} });
    const noTitle = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(noTitle.ok).toBe(false);

    stubFetchOnce({ choices: [{ message: { content: "{\"title\":\"T\"}" }, finish_reason: "stop" }], usage: {} });
    const noDesc = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(noDesc.ok).toBe(false);

    stubFetchOnce({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: {} });
    const noDescLocked = await generateTaskDraft(cfg, { mode: "create", lockedTitle: "L", recentMessages: [{ role: "user", content: "x" }] });
    expect(noDescLocked.ok).toBe(false);
  });

  it("succeeds after retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "garbage" }, finish_reason: "length" }], usage: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "{\"title\":\"T\",\"description\":\"D\"}" }, finish_reason: "stop" }], usage: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await generateTaskDraft(cfg, { mode: "create", recentMessages: [{ role: "user", content: "x" }] });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("extractJsonObject", () => {
  it("parses direct, fenced, and wrapped JSON", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJsonObject('Sure, here: ```{"a":3}``` done')).toEqual({ a: 3 });
    expect(extractJsonObject('Here is the JSON: {"a":4} hope this helps')).toEqual({ a: 4 });
    expect(extractJsonObject('prefix {"a":"{not a brace"} suffix')).toEqual({ a: "{not a brace" });
    expect(extractJsonObject('no braces')).toBeNull();
    expect(extractJsonObject('{"unclosed":')).toBeNull();
  });
});