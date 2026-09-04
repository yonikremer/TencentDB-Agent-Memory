/**
 * WorkBuddy session-init — **header-preselect-only** standalone implementation.
 *
 * ⚠️ Independence rule: this file must NOT import any sibling handler / sibling session module
 * (session/codebuddy/*, session/codex/*, session/claude-code/*). It only relies on
 * **shared infrastructure common to multiple clients**:
 *   - session/store.ts        (generic KV store)
 *   - session/preset.ts       (header parsing + validation, client-agnostic)
 *   - session/registrar.ts    (SessionInfo construction)
 *   - session/context-injector.ts (session_context XML generation)
 *   - session/types.ts (generic types)
 *   - meta/client.ts          (TDAI kernel API client)
 *
 * ============================================================================
 * WorkBuddy client semantics
 * ============================================================================
 * Packet-capture conclusions (see docs/workbuddy-recon/):
 *   - Wire protocol: OpenAI Responses API (same underlying protocol as codex)
 *   - **The system prompt contains no request_user_input-style form tools** (confirmed by real packet capture)
 *   - The client cannot pop up an interactive selection form to let the user choose team/agent/task
 *
 * This session-init therefore degrades to a pure **entry gate**:
 *   - Request header carries complete team+agent+task IDs → validate, then register and continue injection
 *   - Missing any of them → **silent bypass** (pass through upstream, no asset injection)
 *   - Existing session state (same sessionKey reused) → recovered fast path
 *
 * **Key differences** from the CB/codex/CC session-init state machines:
 *   1. Does not return `intercepted=true` (this client cannot receive a form response)
 *   2. No Default gate detection (the client itself never sends a gate signal)
 *   3. No MORE pagination (no interaction needed)
 *   4. No form interception (the client has no form tool)
 * ============================================================================
 */

import type { SessionInitConfig } from "../../types.js";
import type { MetadataClient } from "../../meta/client.js";
import type { SessionStore, SessionIdentity } from "../store.js";
import { buildSessionInfo } from "../registrar.js";
import type {
  AgentDetail,
  SessionInfo,
  SessionInitState,
  TaskDetail,
} from "../types.js";
import { buildSessionContextBlockWithToggles } from "../context-injector.js";
import {
  parsePresetIdentity,
  resolvePresetIdentity,
  type PresetIdentity,
} from "../preset.js";

// ── Result type ──────────────────────────────────────────────────────────────

/**
 * WorkBuddy session-init result. Semantics aligned with the CB/CC/codex
 * SessionInitResult (sessionInfo/agentDetail/taskDetail/systemAppend/bypassed use the same field names),
 * but a **standalone type** to avoid sharing types across handlers.
 */
export interface WorkbuddySessionInitResult {
  /**
   * Whether the session was successfully registered. When false, the caller should skip injection and pass straight through upstream.
   */
  bypassed: boolean;
  /** SessionInfo when registration succeeds; null in the bypass branch. */
  sessionInfo: SessionInfo | null;
  /** Agent details (incl. prompt / persona); null in the bypass branch. */
  agentDetail: AgentDetail | null;
  /** Task details (incl. description / goal); null in the bypass branch. */
  taskDetail: TaskDetail | null;
  /**
   * Prebuilt `<session_context>` block; used to prefill the system message
   * when the injection stage composes the body. null in the bypass branch.
   */
  systemAppend: string | null;
  /**
   * Whether this round is a **fresh registration** (recovered fast-path reuse = false, first-time registration = true).
   * Used to decide whether to trigger an injection prewarm.
   */
  justRegistered: boolean;
  /**
   * Reason for taking the bypass, used for logging/telemetry analysis:
   *   - "no-header": request did not carry the x-tdai-team-id header (client has no form fallback → bypass directly)
   *   - "incomplete-header": header has a team but is missing agent or task
   *   - "mismatch": header value does not match the team/agent list returned by the kernel
   *   - "kernel-error": the kernel API call failed
   *   - "config-disabled": sessionInit.enabled=false or headerAutoSelect.enabled=false
   */
  bypassReason?:
    | "no-header"
    | "incomplete-header"
    | "mismatch"
    | "kernel-error"
    | "config-disabled";
}

// ── Request context ──────────────────────────────────────────────────────────

/**
 * Runtime context passed through when calling handleWorkbuddySessionInit
 * (parameters unrelated to the request are passed as separate arguments).
 */
export interface WorkbuddyRequestContext {
  /** SSE stream flag — reserved for future form scenarios; this handler currently does not build form responses. */
  stream: boolean;
  /** The model ID requested by the client; passed through to logs/telemetry. */
  modelId: string;
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * WorkBuddy session-init entry point.
 *
 * Flow (see top of the module doc):
 *   1. sessionInit.enabled=false → bypass(config-disabled)
 *   2. Reuse existing state from the store → recovered fast path directly
 *   2.5 **DEBUG**: `sessionInit.debugForceIdentity` complete (team+agent+task) →
 *      skip header and kernel listTeams validation, register directly with the fixed triplet (local/e2e only)
 *   3. Parse preset identity (three headers):
 *      - no team header → bypass(no-header)
 *      - has a team header but missing agent or task → bypass(incomplete-header)
 *      - team+agent+task complete → fetch the kernel team list to validate
 *        - resolvePresetIdentity.canRegister=true → complete registration
 *        - validation failed → bypass(mismatch)
 *   4. After successful registration, persist to the store (next round takes the recovered branch)
 *
 * @param sessionKey     dedupe key (usually the client session_id or the fallback keyId:traceId)
 * @param userId         user ID resolved from the apiKey (may be null)
 * @param config         SessionInitConfig (includes the headerAutoSelect config)
 * @param store          generic SessionStore (shared by multiple clients, isolated by the `workbuddy:` prefix)
 * @param reqCtx         request runtime context
 * @param headers        lowercased request header map
 * @param agentSource    always "workbuddy" (compositeKey prefix)
 * @param metadataClient TDAI kernel client; may be undefined in the bypass branch
 * @param userKey        the raw apiKey, persisted to SessionInfo.user_key
 * @param spaceId        spaceId from the URL path
 */
export async function handleWorkbuddySessionInit(
  sessionKey: string,
  userId: string | null,
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: WorkbuddyRequestContext,
  headers: Record<string, string>,
  agentSource: string,
  metadataClient: MetadataClient | undefined,
  userKey: string | undefined,
  spaceId: string | undefined,
): Promise<WorkbuddySessionInitResult> {
  void reqCtx; // kept for future extension (stream/modelId will be used by form / MORE pagination)

  // ── 1. Config gate ──────────────────────────────────────────────────────────
  if (!config.enabled) {
    return bypassResult("config-disabled");
  }

  const compositeKey = `${agentSource}:${sessionKey}`;
  const identity: SessionIdentity = {
    userId: userId || "anonymous",
    agentSource,
    sessionId: sessionKey,
    spaceId: spaceId || "",
  };

  // ── 2. Reuse existing state (recovered fast path) ──────────────────────────
  // getOrRecover binds the identity internally; no need to call store.bind separately
  const recovered = await store.getOrRecover(compositeKey, identity, {
    metadataClient,
    messages: [], // WorkBuddy has no form → no history-scan recovery needed
  });

  if (recovered && recovered.status === "initialized") {
    const sessionInfo = recovered.sessionInfo ?? null;
    const agentDetail = recovered.agentDetail ?? null;
    const taskDetail = recovered.taskDetail ?? null;
    const bypassed = Boolean(recovered.bypassed);

    const systemAppend = bypassed
      ? null
      : buildSessionContextBlockWithToggles(
          agentDetail,
          taskDetail,
          config,
          sessionKey,
        );

    return {
      bypassed,
      sessionInfo: bypassed ? null : sessionInfo,
      agentDetail: bypassed ? null : agentDetail,
      taskDetail: bypassed ? null : taskDetail,
      systemAppend,
      justRegistered: false,
    };
  }

  // ── 2.5 DEBUG BYPASS: force-inject via debugForceIdentity (local dev / e2e) ──
  // Purpose: bypass header parsing + kernel listTeams validation and register directly
  //       with the fixed triplet (team_id, agent_id, task_id) from the config. Only for local/e2e runs.
  // Semantics aligned with the CC version: team+agent+task must all be present to take this path
  // (missing any one ignores the debug config and falls back to the normal preset flow),
  // guaranteeing that the task needed for injection always exists.
  if (
    config.debugForceIdentity &&
    config.debugForceIdentity.team_id &&
    config.debugForceIdentity.agent_id &&
    config.debugForceIdentity.task_id
  ) {
    // Hoisted into local constants so TS narrows task_id to string (its declared type is string | undefined)
    const forcedTeamId: string = config.debugForceIdentity.team_id;
    const forcedAgentId: string = config.debugForceIdentity.agent_id;
    const forcedTaskId: string = config.debugForceIdentity.task_id;
    const forcedUserId = identity.userId;
    console.log(
      `[workbuddy-init] session=${compositeKey} DEBUG bypass — force identity ` +
        `team=${forcedTeamId} agent=${forcedAgentId} task=${forcedTaskId} user=${forcedUserId}`,
    );

    // Try to fill in agent/task detail (degrade to empty on failure) — mirrors paragraph 5 of the main path
    let agentDetail: AgentDetail | null = null;
    let taskDetail: TaskDetail | null = null;
    if (metadataClient) {
      try {
        const agent = await metadataClient.getAgent(forcedAgentId);
        agentDetail = {
          id: agent.agent_id,
          name: agent.name,
          description: agent.description ?? undefined,
          prompt: agent.prompt ?? undefined,
        };
      } catch (err) {
        console.warn(
          `[workbuddy-init] DEBUG getAgent(${forcedAgentId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        const task = await metadataClient.getTask(forcedTaskId);
        taskDetail = {
          id: task.task_id,
          name: task.title,
          description: task.description ?? undefined,
        };
      } catch (err) {
        console.warn(
          `[workbuddy-init] DEBUG getTask(${forcedTaskId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const sessionInfo = buildSessionInfo(
      {
        session_id: sessionKey,
        team_id: forcedTeamId,
        agent_id: forcedAgentId,
        task_id: forcedTaskId,
        user_id: forcedUserId,
      },
      userKey,
      spaceId,
    );

    await store.set(compositeKey, {
      status: "initialized",
      keyId: compositeKey,
      startedAt: Date.now(),
      attemptCount: 0,
      bypassed: false,
      sessionInfo,
      userId: identity.userId,
      agentDetail,
      taskDetail,
    } as SessionInitState);

    const systemAppend = buildSessionContextBlockWithToggles(
      agentDetail,
      taskDetail,
      config,
      sessionKey,
    );

    return {
      bypassed: false,
      sessionInfo,
      agentDetail,
      taskDetail,
      systemAppend,
      justRegistered: true,
    };
  }

  // ── 3. Parse preset identity ────────────────────────────────────────────────
  const preset: PresetIdentity | undefined = parsePresetIdentity(config, headers);
  if (!preset || !preset.teamId) {
    // no team header → the WorkBuddy client has no form fallback → bypass directly
    await persistBypass(store, compositeKey, identity);
    return bypassResult("no-header");
  }
  if (!preset.agentId || !preset.taskId) {
    // team present but missing agent or task → cannot fully register, bypass directly
    // (resolvePresetIdentity would also return canRegister=false; returning early here reduces kernel calls)
    await persistBypass(store, compositeKey, identity);
    return bypassResult("incomplete-header");
  }

  // ── 4. Fetch the kernel team list to validate the preset ───────────────────
  if (!metadataClient) {
    // no kernel client (config has no tdai.endpoint / apiKey is incomplete) → bypass
    // do not persist a store bypass — recovers automatically once the config is fixed
    return bypassResult("kernel-error");
  }

  // Fetch the list of teams visible to the current user via the kernel, then fan out to fill in agents / tasks
  // (resolvePresetIdentity needs the TeamOption[] structure)
  let teams: import("../types.js").TeamOption[];
  try {
    const teamsRaw = await metadataClient.listTeams(identity.userId);
    teams = await Promise.all(
      teamsRaw.map(async (t) => {
        const [agentsRaw, tasksRaw] = await Promise.all([
          metadataClient.listAgents(t.team_id).catch(() => []),
          metadataClient.listTasks(t.team_id).catch(() => []),
        ]);
        return {
          team_id: t.team_id,
          team_name: t.name ?? t.team_id,
          agents: agentsRaw.map((a) => ({
            agent_id: a.agent_id,
            agent_name: a.name ?? a.agent_id,
          })),
          tasks: tasksRaw.map((tk) => ({
            task_id: tk.task_id,
            task_name: tk.title ?? tk.task_id,
          })),
        };
      }),
    );
  } catch (err) {
    console.warn(
      `[workbuddy-init] session=${sessionKey} listTeams failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // do not persist a store bypass — kernel errors may be transient, the next request can retry
    return bypassResult("kernel-error");
  }

  const resolution = resolvePresetIdentity(teams, preset);
  if (!resolution.canRegister) {
    // validation failed: header value does not match the team/agent/task visible to the user → long-term bypass
    // (the client will still send the same header on the next request, so retrying is pointless)
    await persistBypass(store, compositeKey, identity);
    return bypassResult("mismatch");
  }

  // ── 5. Fetch agent / task detail ──────────────────────────────────────────
  let agentDetail: AgentDetail | null = null;
  let taskDetail: TaskDetail | null = null;
  try {
    if (resolution.agentId) {
      const agent = await metadataClient.getAgent(resolution.agentId);
      agentDetail = {
        id: agent.agent_id,
        name: agent.name,
        description: agent.description ?? undefined,
        prompt: agent.prompt ?? undefined,
      };
    }
  } catch (err) {
    console.warn(
      `[workbuddy-init] getAgent(${resolution.agentId}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    if (resolution.taskId) {
      const task = await metadataClient.getTask(resolution.taskId);
      taskDetail = {
        id: task.task_id,
        name: task.title,
        description: task.description ?? undefined,
      };
    }
  } catch (err) {
    console.warn(
      `[workbuddy-init] getTask(${resolution.taskId}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── 6. Build SessionInfo & persist to store ─────────────────────────────────
  const sessionInfo = buildSessionInfo(
    {
      session_id: sessionKey,
      team_id: resolution.teamId!,
      agent_id: resolution.agentId!,
      task_id: resolution.taskId,
      user_id: userId || "anonymous",
    },
    userKey,
    spaceId,
  );

  const initState: SessionInitState = {
    status: "initialized",
    keyId: compositeKey,
    startedAt: Date.now(),
    attemptCount: 0,
    bypassed: false,
    sessionInfo,
    userId: identity.userId,
    agentDetail,
    taskDetail,
  };
  await store.set(compositeKey, initState);

  const systemAppend = buildSessionContextBlockWithToggles(
    agentDetail,
    taskDetail,
    config,
    sessionKey,
  );

  return {
    bypassed: false,
    sessionInfo,
    agentDetail,
    taskDetail,
    systemAppend,
    justRegistered: true,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function bypassResult(
  reason: WorkbuddySessionInitResult["bypassReason"],
): WorkbuddySessionInitResult {
  return {
    bypassed: true,
    sessionInfo: null,
    agentDetail: null,
    taskDetail: null,
    systemAppend: null,
    justRegistered: false,
    bypassReason: reason,
  };
}

/**
 * Persist the bypass decision into the SessionStore (terminal `initialized` + `bypassed=true`),
 * so the next request takes the recovered fast path and returns the bypass directly.
 *
 * bypassReason is not persisted (SessionInitState has no such field); it is only carried
 * on this handler's return value.
 */
async function persistBypass(
  store: SessionStore,
  compositeKey: string,
  identity: SessionIdentity,
): Promise<void> {
  store.bind(compositeKey, identity);
  try {
    await store.set(compositeKey, {
      status: "initialized",
      keyId: compositeKey,
      startedAt: Date.now(),
      attemptCount: 0,
      bypassed: true,
      sessionInfo: null,
      userId: identity.userId,
      agentDetail: null,
      taskDetail: null,
    });
  } catch (err) {
    console.warn(
      `[workbuddy-init] persistBypass failed for key=${compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
