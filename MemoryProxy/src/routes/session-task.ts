/**
 * Core flow for mem:create-task / mem:update-task:
 * start from the current session context, generate a Task, write it to metadata, and bind it to the session.
 *
 * Interaction model ("user confirmation" gate — destructive operations require draft first, then confirm):
 *   - createTaskFromSession
 *       Not bound to a real task → LLM generates title+description → persist and bind directly (done in one step)
 *       Bound to a real task → generate a new draft → write pending → return pending, wait for the user to confirm/cancel
 *   - updateTaskFromSession
 *       No task_id bound → intercept and return an error, guide the user to run mem:create-task first
 *       Bound: fetch the current task → generate a draft (incl. status suggestion) → write pending → return pending
 *               non-creator is no longer rejected; instead the warning is attached to pending and reported to the user on confirm
 *   - confirmPendingTaskAction / cancelPendingTaskAction
 *       Take the payload from the pending-store and perform the real create / update / rebind / clear pending
 *
 * Key constraints (kernel-aligned):
 *   - on create, pass agent_id so the kernel associates the current Agent (per the original TAPD requirement)
 *   - do **not change title** when persisting (consistent with the existing product convention; the kernel allows it but the product doesn't)
 *   - on update, status is proposed by the LLM; the proxy passes it straight through to the kernel without enum validation
 *   - creator_user_id / team_id strictly come from sessionInfo to prevent privilege escalation
 *   - taskDraft not configured = return "config missing" directly (no local fallback)
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import type { MemCommandMessage } from "../mem-command/types.js";
import { getSessionStore } from "../session/store.js";
import type { SessionInitState, SessionInfo } from "../session/types.js";
import { getMetadataClient } from "../meta/client.js";
import type { TaskEntity } from "../meta/client.js";
import { generateTaskDraft } from "../mem-command/task-draft-generator.js";
import {
  clearPending,
  getPending,
  makePendingKey,
  setPending,
  type PendingCreatePayload,
  type PendingUpdatePayload,
} from "../mem-command/pending-store.js";

// ── Input / output types ────────────────────────────────────────────────────────

export interface CreateTaskFromSessionInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  /** User hint (free text after mem:create-task), optional */
  hint?: string;
  /** Recent conversation (used to generate the draft) */
  recentMessages: MemCommandMessage[];
  /**
   * Title written verbatim by the user after mem:create-task (truncation to 40 chars is the caller's job).
   *   - present: the title is locked, the LLM only generates the description; on LLM failure, degrade to an empty desc but still persist the task.
   *   - absent: both title + description are inferred by the LLM from the conversation; on LLM failure, return an error directly.
   */
  lockedTitle?: string;
}

export interface UpdateTaskFromSessionInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
  hint?: string;
  recentMessages: MemCommandMessage[];
  /**
   * Description written verbatim by the user after mem:update-task.
   *   - present: description is replaced directly with this text, no LLM call.
   *   - absent: ask the LLM to diff out a new description (not persisted when changed=false).
   */
  directDescription?: string;
}

/** confirm/cancel input (no recentMessages, since the draft already sits in pending) */
export interface PendingActionInput {
  sessionKey: string;
  agentSource: string;
  config: ProxyConfig;
  spaceId: string;
}

/** Pending summary for the first call of the create command (for the command layer to build preview copy) */
export interface PendingCreateInfo {
  kind: "create";
  draftTitle: string;
  draftDescription: string;
  currentTaskId: string;
  currentTaskTitle?: string;
}

/** Pending summary for the first call of the update command */
export interface PendingUpdateInfo {
  kind: "update";
  taskId: string;
  currentTitle?: string;
  currentDescription?: string;
  currentStatus?: string;
  draftDescription: string;
  statusSuggestion?: string;
}

export type PendingInfo = PendingCreateInfo | PendingUpdateInfo;

export interface TaskFromSessionResult {
  success: boolean;
  /** taskId on success */
  taskId?: string;
  /** final title on success */
  title?: string;
  /** final description on success */
  description?: string;
  /** final status on success */
  status?: string;
  /** update mode: true when the LLM decides "no update needed" — nothing was persisted */
  noUpdateNeeded?: boolean;
  /**
   * create mode: the session already has a bound task_id — a legacy compat flag; under the new flow pending is returned alongside.
   * Field name kept for compatibility with the HTTP handler response envelope (respond() reads it to decide on a 409).
   */
  alreadyBound?: boolean;
  /**
   * The first call produced a pending draft awaiting user confirmation. Nothing persisted; the command layer should build the preview copy,
   * guiding the next reply to `mem:create-task confirm` / `mem:update-task confirm` or `... cancel`.
   */
  pending?: PendingInfo;
  /** confirm branch: no matching pending on the session (may have expired, been cancelled, or never been created) */
  noPending?: boolean;
  /** cancel branch: whether a pending was found and cleared */
  cancelled?: boolean;
  /** create rebind branch: the previously bound old task_id (for the return copy) */
  previousTaskId?: string;
  /** failure reason, for callers to compose user-visible copy */
  error?: string;
}

// ── Internal: common checks that resolve session state ─────────────────────────────────────

interface ResolvedSession {
  state: SessionInitState;
  sessionInfo: SessionInfo;
  teamId: string;
  userId: string;
  currentTaskId?: string;
}

function resolveSession(
  sessionKey: string,
  agentSource: string,
  config: ProxyConfig,
): ResolvedSession | { error: string } {
  if (!sessionKey) return { error: "session_key is required" };

  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state = store.get(compositeKey);

  if (!state || !state.sessionInfo) {
    return { error: `Session not found: ${sessionKey}` };
  }

  const sessionInfo = state.sessionInfo;
  const teamId = sessionInfo.team_id ?? "";
  const userId = sessionInfo.user_id ?? "";
  if (!teamId || !userId) {
    return { error: "session missing team_id/user_id (initialization incomplete)" };
  }

  // The "Don't bind a task this time" mode goes through config.sessionInit.defaultTaskId (a virtual value that doesn't exist in the kernel),
  // and counts as **not bound to a real task** — create-task is allowed, update-task is not (the latter returns an error via the no-task branch).
  const rawTaskId = sessionInfo.task_id;
  const defaultTaskId = config.sessionInit?.defaultTaskId;
  const isVirtualDefault = !!rawTaskId && !!defaultTaskId && rawTaskId === defaultTaskId;
  const currentTaskId = isVirtualDefault ? undefined : rawTaskId;

  return { state, sessionInfo, teamId, userId, ...(currentTaskId ? { currentTaskId } : {}) };
}

// ── Internal: check and fetch the taskDraft config ─────────────────────────────────────────

function resolveTaskDraftConfig(config: ProxyConfig) {
  const draft = config.memCommand?.taskDraft;
  if (!draft || !draft.enabled) {
    return { error: "task_draft is not configured (see config.memCommand.taskDraft)" } as const;
  }
  return { cfg: draft } as const;
}

function getClientFromResolved(resolved: ResolvedSession, config: ProxyConfig, fallbackSpaceId: string) {
  return getMetadataClient(
    config.coreSkill,
    resolved.sessionInfo.space_id ?? fallbackSpaceId,
    resolved.sessionInfo.user_key ?? "",
  );
}

function normalizeDesc(d: string | null | undefined): string | undefined {
  return d == null ? undefined : d;
}

/** Build the pending key from the resolved session (covering the team/agent/session triple). */
function pendingKeyOf(resolved: ResolvedSession, agentSource: string, sessionKey: string): string {
  return makePendingKey({
    team_id: resolved.teamId,
    // pending-store's agent uses sessionInfo.agent_id (a kernel-side concept); when missing, fall back to agentSource
    agent_id: resolved.sessionInfo.agent_id ?? agentSource,
    session_id: sessionKey,
  });
}

// ── Internal: the two atomic persist operations (used on the first direct save and on confirm) ────────

/**
 * Runs create: calls kernel createTask, then binds the session.
 * agent_id is taken from sessionInfo when present; when missing it is omitted (left to the kernel).
 */
async function doCreateAndBind(
  resolved: ResolvedSession,
  input: { sessionKey: string; agentSource: string; config: ProxyConfig; spaceId: string },
  title: string,
  description: string,
): Promise<{ ok: true; task: TaskEntity; bindWarning?: string } | { ok: false; error: string }> {
  let created: TaskEntity;
  try {
    const client = getClientFromResolved(resolved, input.config, input.spaceId);
    created = await client.createTask({
      team_id: resolved.teamId,
      creator_user_id: resolved.userId,
      title,
      description,
      ...(resolved.sessionInfo.agent_id ? { agent_id: resolved.sessionInfo.agent_id } : {}),
    });
  } catch (err) {
    return { ok: false, error: `metadata createTask failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    await bindTaskIdToSession(input.sessionKey, input.agentSource, created.task_id);
  } catch (err) {
    return {
      ok: true,
      task: created,
      bindWarning: `task created but session bind failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, task: created };
}

// ── Core: create-task ─────────────────────────────────────────────────────
//
// Interaction tiers:
//   Not bound + any args → LLM generates a draft → persist immediately (no confirm needed)
//   Bound to a real task → LLM generates a draft → write pending, wait for confirm/cancel

export async function createTaskFromSession(
  input: CreateTaskFromSessionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const draftCfg = resolveTaskDraftConfig(input.config);
  if ("error" in draftCfg) return { success: false, error: draftCfg.error };

  // Step 1: LLM generates the draft (lockedTitle yields only a description)
  const draft = await generateTaskDraft(draftCfg.cfg, {
    mode: "create",
    hint: input.hint,
    recentMessages: input.recentMessages,
    ...(input.lockedTitle ? { lockedTitle: input.lockedTitle } : {}),
  });

  // Step 1a: normalize the result
  //
  // Three-tier fallback (2026-08-18 fix for an over-high failure rate):
  //   1) draft.ok=true          → use the LLM result
  //   2) draft.ok=false + lockedTitle → title=lockedTitle, desc=""
  //   3) draft.ok=false + no args → "Untitled task_yyMMdd_HHmm" fallback, desc="", so the user can fill it in later with mem:update-task
  //
  // Previously tier 3 returned a hard error, so any LLM hiccup forced the user to retry 3 times — a very poor UX.
  // Now a default name is assigned and bound, and once the user gets the taskId they can add a description anytime;
  // the fallback error is surfaced via bindWarning, and the UI layer may optionally show "AI naming failed, used the default name".
  let finalTitle: string;
  let finalDescription: string;
  let draftFallbackWarning: string | undefined;
  if (draft.ok) {
    finalTitle = draft.title;
    finalDescription = draft.description;
  } else if (input.lockedTitle) {
    // args present + LLM failure → degrade: title uses the arg, desc is left empty
    finalTitle = input.lockedTitle;
    finalDescription = "";
    draftFallbackWarning = `AI description failed (${draft.error}); saved with empty description`;
  } else {
    // no args + LLM failure → fallback: "Untitled task_yyMMdd_HHmm"
    finalTitle = buildFallbackTaskTitle();
    finalDescription = "";
    draftFallbackWarning = `AI draft failed (${draft.error}); saved with default title, use mem:update-task to refine`;
  }

  // Step 2a: bound to a real task → write pending, wait for confirm to rebind
  if (resolved.currentTaskId) {
    let boundTitle: string | undefined;
    try {
      const client = getClientFromResolved(resolved, input.config, input.spaceId);
      const t = await client.getTask(resolved.currentTaskId);
      boundTitle = t.title;
    } catch {
      // failing to fetch the old task title does not block (it only affects the preview display)
    }
    const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
    const payload: PendingCreatePayload = {
      kind: "create",
      draft: {
        title: finalTitle,
        description: finalDescription,
        ...(input.hint ? { hint: input.hint } : {}),
      },
      currentTaskId: resolved.currentTaskId,
      ...(boundTitle ? { currentTaskTitle: boundTitle } : {}),
    };
    setPending(key, payload);
    return {
      success: true,
      alreadyBound: true,
      taskId: resolved.currentTaskId,
      ...(boundTitle ? { title: boundTitle } : {}),
      pending: {
        kind: "create",
        draftTitle: finalTitle,
        draftDescription: finalDescription,
        currentTaskId: resolved.currentTaskId,
        ...(boundTitle ? { currentTaskTitle: boundTitle } : {}),
      },
      ...(draftFallbackWarning ? { error: draftFallbackWarning } : {}),
    };
  }

  // Step 2b: not bound → persist directly
  const persisted = await doCreateAndBind(resolved, input, finalTitle, finalDescription);
  if (!persisted.ok) return { success: false, error: persisted.error };
  const created = persisted.task;
  // Combine the two warning kinds — AI fallback + bind failure — and surface them upward through the error field
  // (the error field name is legacy; its meaning is "success=true but with a warning")
  const combinedWarning = [draftFallbackWarning, persisted.bindWarning]
    .filter((w): w is string => !!w)
    .join("; ");
  return {
    success: true,
    taskId: created.task_id,
    title: created.title,
    description: normalizeDesc(created.description),
    status: created.status,
    ...(combinedWarning ? { error: combinedWarning } : {}),
  };
}

/**
 * Generate an "Untitled task_yyyyMMdd_HHmm" title as the LLM fallback.
 *
 * The timestamp is accurate to the minute, balancing readability & searchability:
 *   - seeing "Untitled task_260818_1710" lets the user immediately tell when it was created
 *   - seconds are not used, to avoid duplicate names from rapid consecutive creates — and opening two tasks within a minute is abnormal anyway
 * Guaranteed to be ≤ MAX_TITLE_LEN(40) characters.
 */
function buildFallbackTaskTitle(): string {
  const now = new Date();
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `Untitled task_${yy}${MM}${dd}_${HH}${mm}`;
}

// ── Core: update-task ─────────────────────────────────────────────────────
//
// Interaction tiers (confirm is needed every time):
//   Not bound → intercept and return an error, have the user create-task first
//   Bound → fetch the current task → generate a draft (incl. status suggestion) → write pending → return pending
//           non-creator is rejected directly (the kernel also doesn't support cross-user update; the proxy pre-empts with guidance to create-task)

export async function updateTaskFromSession(
  input: UpdateTaskFromSessionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  if (!resolved.currentTaskId) {
    return {
      success: false,
      error:
        "no task bound to this session (session is in \"Don't bind a task this time\" mode or task_id missing); " +
        "use mem:create-task to create and bind a new task first",
    };
  }

  // Only the no-args branch needs the LLM config
  if (!input.directDescription) {
    const draftCfg = resolveTaskDraftConfig(input.config);
    if ("error" in draftCfg) return { success: false, error: draftCfg.error };
  }

  // Step 1: fetch the current task
  const client = getClientFromResolved(resolved, input.config, input.spaceId);
  let current: TaskEntity;
  try {
    current = await client.getTask(resolved.currentTaskId);
  } catch (err) {
    return {
      success: false,
      error: `metadata getTask failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Reject non-creators directly (the kernel still rejects cross-user update via its owner-check; the proxy pre-empts here to give clear guidance)
  if (current.creator_user_id && current.creator_user_id !== resolved.userId) {
    return {
      success: false,
      error: "not_creator",
    };
  }

  // Step 2: determine the new description + statusSuggestion
  let newDescription: string;
  let statusSuggestion: string | undefined;
  if (input.directDescription !== undefined) {
    // args present: replace directly, no LLM call, and no status suggestion
    newDescription = input.directDescription;
  } else {
    const draftCfg = resolveTaskDraftConfig(input.config);
    if ("error" in draftCfg) return { success: false, error: draftCfg.error };

    const draft = await generateTaskDraft(draftCfg.cfg, {
      mode: "update",
      hint: input.hint,
      recentMessages: input.recentMessages,
      currentTask: {
        title: current.title,
        description: current.description ?? "",
        status: current.status ?? "running",
      },
    });
    if (!draft.ok) return { success: false, error: `draft failed: ${draft.error}` };
    if (!draft.changed) {
      // LLM found no change → don't write pending, return noUpdateNeeded directly
      return {
        success: true,
        noUpdateNeeded: true,
        taskId: current.task_id,
        title: current.title,
        description: normalizeDesc(current.description),
        status: current.status,
      };
    }
    newDescription = draft.description;
    statusSuggestion = draft.suggestedStatus;
  }

  // Step 3: write pending, wait for confirm
  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const payload: PendingUpdatePayload = {
    kind: "update",
    draft: {
      taskId: current.task_id,
      description: newDescription,
      ...(statusSuggestion ? { statusSuggestion } : {}),
      ...(current.title ? { currentTitle: current.title } : {}),
      ...(current.status ? { currentStatus: current.status } : {}),
      ...(input.hint ? { hint: input.hint } : {}),
    },
  };
  setPending(key, payload);

  return {
    success: true,
    taskId: current.task_id,
    title: current.title,
    description: normalizeDesc(current.description),
    status: current.status,
    pending: {
      kind: "update",
      taskId: current.task_id,
      ...(current.title ? { currentTitle: current.title } : {}),
      ...(current.description ? { currentDescription: current.description } : {}),
      ...(current.status ? { currentStatus: current.status } : {}),
      draftDescription: newDescription,
      ...(statusSuggestion ? { statusSuggestion } : {}),
    },
  };
}

// ── Core: confirm / cancel ────────────────────────────────────────────────

/**
 * Called when the user replies `mem:create-task confirm` or `mem:update-task confirm`.
 * Dispatches by the kind stored in pending:
 *   - create → doCreateAndBind (rebinds over the original binding)
 *   - update → kernel updateTask (description + status passed through)
 * Clears pending after a successful persist; on failure the pending is kept (so the user can retry).
 */
export async function confirmPendingTaskAction(
  input: PendingActionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const payload = getPending(key);
  if (!payload) {
    return { success: false, noPending: true, error: "no pending task action (may have expired or been cancelled)" };
  }

  if (payload.kind === "create") {
    const previousTaskId = payload.currentTaskId;
    const persisted = await doCreateAndBind(
      resolved,
      input,
      payload.draft.title,
      payload.draft.description,
    );
    if (!persisted.ok) {
      // persist failed: keep the pending so the user can retry
      return { success: false, error: persisted.error };
    }
    clearPending(key);
    const t = persisted.task;
    return {
      success: true,
      taskId: t.task_id,
      title: t.title,
      description: normalizeDesc(t.description),
      status: t.status,
      previousTaskId,
      ...(persisted.bindWarning ? { error: persisted.bindWarning } : {}),
    };
  }

  // update branch
  const client = getClientFromResolved(resolved, input.config, input.spaceId);
  let updated: TaskEntity;
  try {
    updated = await client.updateTask(payload.draft.taskId, {
      description: payload.draft.description,
      ...(payload.draft.statusSuggestion ? { status: payload.draft.statusSuggestion } : {}),
    });
  } catch (err) {
    return {
      success: false,
      error: `metadata updateTask failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  clearPending(key);
  return {
    success: true,
    taskId: updated.task_id,
    title: updated.title,
    description: normalizeDesc(updated.description),
    status: updated.status,
  };
}

/**
 * Called when the user replies `mem:create-task cancel` or `mem:update-task cancel`:
 * clears pending without persisting. Returns cancelled=true so the command layer can compose the prompt copy.
 */
export async function cancelPendingTaskAction(
  input: PendingActionInput,
): Promise<TaskFromSessionResult> {
  const resolved = resolveSession(input.sessionKey, input.agentSource, input.config);
  if ("error" in resolved) return { success: false, error: resolved.error };

  const key = pendingKeyOf(resolved, input.agentSource, input.sessionKey);
  const existed = clearPending(key);
  return { success: true, cancelled: existed };
}

// ── Internal: write taskId back to sessionInfo ──────────────────────────────────────

async function bindTaskIdToSession(
  sessionKey: string,
  agentSource: string,
  taskId: string,
): Promise<void> {
  const compositeKey = `${agentSource}:${sessionKey}`;
  const store = getSessionStore();
  const state = store.get(compositeKey);
  if (!state || !state.sessionInfo) {
    throw new Error(`session ${sessionKey} vanished during bind`);
  }
  const newSessionInfo: SessionInfo = { ...state.sessionInfo, task_id: taskId };
  const newState: SessionInitState = { ...state, sessionInfo: newSessionInfo };
  await store.set(compositeKey, newState);
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────

/**
 * POST /v3/session/create-task
 *
 * Used by the panel frontend / e2e. The body looks like:
 *   { session_key, agent_source, space_id, hint?, locked_title?, recent_messages?: [...] }
 * If recent_messages is omitted it returns "no recent messages" — the panel must pass it in (pull the
 * latest N entries from conversation/query).
 */
export function createSessionCreateTaskHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `create-task-${Date.now()}` }, 400);
    }

    const parsed = parseCreateTaskBody(body);
    if ("error" in parsed) {
      return c.json({ code: 40001, message: parsed.error, request_id: `create-task-${Date.now()}` }, 400);
    }

    const result = await createTaskFromSession({ ...parsed, config });
    return respond(c, result, "create-task");
  };
}

/**
 * POST /v3/session/update-task —— same as above, but runs the update branch.
 */
export function createSessionUpdateTaskHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ code: 40001, message: "Invalid JSON body", request_id: `update-task-${Date.now()}` }, 400);
    }

    const parsed = parseUpdateTaskBody(body);
    if ("error" in parsed) {
      return c.json({ code: 40001, message: parsed.error, request_id: `update-task-${Date.now()}` }, 400);
    }

    const result = await updateTaskFromSession({ ...parsed, config });
    return respond(c, result, "update-task");
  };
}

// ── HTTP body parsing ────────────────────────────────────────────────────────

function parseCommonBody(
  body: Record<string, unknown>,
):
  | { sessionKey: string; agentSource: string; spaceId: string; hint?: string; recentMessages: MemCommandMessage[] }
  | { error: string } {
  const sessionKey = typeof body.session_key === "string" ? body.session_key : "";
  if (!sessionKey) return { error: "session_key is required" };
  const agentSource = typeof body.agent_source === "string" ? body.agent_source : "claude-code";
  const spaceId = typeof body.space_id === "string" ? body.space_id : "";
  const hint = typeof body.hint === "string" ? body.hint : undefined;

  const rawMsgs = Array.isArray(body.recent_messages) ? body.recent_messages : [];
  const recentMessages: MemCommandMessage[] = [];
  for (const m of rawMsgs) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const role = obj.role;
    const content = obj.content;
    if (
      (role === "user" || role === "assistant" || role === "system") &&
      typeof content === "string" &&
      content.length > 0
    ) {
      recentMessages.push({ role, content });
    }
  }

  return { sessionKey, agentSource, spaceId, hint, recentMessages };
}

function parseCreateTaskBody(
  body: Record<string, unknown>,
):
  | {
      sessionKey: string;
      agentSource: string;
      spaceId: string;
      hint?: string;
      recentMessages: MemCommandMessage[];
      lockedTitle?: string;
    }
  | { error: string } {
  const base = parseCommonBody(body);
  if ("error" in base) return base;
  const lockedTitle = typeof body.locked_title === "string" && body.locked_title.trim().length > 0
    ? body.locked_title.trim()
    : undefined;
  return { ...base, ...(lockedTitle ? { lockedTitle } : {}) };
}

function parseUpdateTaskBody(
  body: Record<string, unknown>,
):
  | {
      sessionKey: string;
      agentSource: string;
      spaceId: string;
      hint?: string;
      recentMessages: MemCommandMessage[];
      directDescription?: string;
    }
  | { error: string } {
  const base = parseCommonBody(body);
  if ("error" in base) return base;
  const directDescription = typeof body.direct_description === "string"
    ? body.direct_description
    : undefined;
  return { ...base, ...(directDescription !== undefined ? { directDescription } : {}) };
}

function respond(c: Context, result: TaskFromSessionResult, tag: string): Response {
  const requestId = `${tag}-${Date.now()}`;
  if (!result.success) {
    const isNoPending = result.noPending === true;
    const isNotFound = result.error?.includes("not found") || result.error?.includes("no task bound");
    const status = isNoPending ? 404 : isNotFound ? 404 : 500;
    const code = isNoPending ? 40402 : isNotFound ? 40401 : 50001;
    return c.json(
      {
        code,
        message: result.error,
        request_id: requestId,
      },
      status,
    );
  }
  return c.json({
    code: 0,
    message: "ok",
    request_id: requestId,
    data: {
      task_id: result.taskId,
      title: result.title,
      description: result.description,
      status: result.status,
      no_update_needed: result.noUpdateNeeded ?? false,
      ...(result.pending ? { pending: result.pending } : {}),
      ...(result.cancelled !== undefined ? { cancelled: result.cancelled } : {}),
      ...(result.previousTaskId ? { previous_task_id: result.previousTaskId } : {}),
    },
  });
}
