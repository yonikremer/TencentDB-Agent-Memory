/**
 * Session initialization types.
 */

/**
 * Label of the virtual entry that fetchTeamsAndAgents injects at the head of
 * each team's tasks list when falling back on `config.defaultTaskId`.
 *
 * By injecting at the source instead of branching in the form / extractor,
 * pagination total, auto-select cascade and extractor matching all keep going
 * through the existing tasks.length path, avoiding "scattered pagination
 * truth"-style bugs (see the defaultTaskId notes in docs & the 2026-07-29 issue).
 */
export const DEFAULT_TASK_LABEL = "Don't bind a task this time";

/**
 * Session-init state machine:
 *   uninitialized           → first entry; control plane pulls teams[]
 *   pending_asset_confirm   → round-0 form sent (associate team assets?), awaiting answer
 *   pending_team_select     → "yes" chosen, round-1 form sent (team only), awaiting answer
 *   pending_agent_task      → team chosen, round-2 form sent (agent + task), awaiting answer
 *   initialized             → full triple identified, registration done
 *
 * When teams.length === 1, skip pending_team_select and go straight to pending_agent_task.
 * If the user picks "no" during pending_asset_confirm, bypass directly.
 */
export type SessionInitStatus =
  | "uninitialized"
  | "pending_asset_confirm"
  | "pending_team_select"
  | "pending_agent_task"     // legacy
  | "pending_agent_select"  // CC: selecting agent (with pagination)
  | "pending_task_select"   // CC: selecting task (with pagination)
  | "initialized"
  // legacy (phase-1 single form), kept to stay compatible with old tests / old store data
  | "pending_form";

export interface SessionInitState {
  status: SessionInitStatus;
  keyId: string;
  startedAt: number;
  attemptCount: number;
  sessionInfo?: SessionInfo | null;
  /** User ID from auth/verify (not from header). */
  userId?: string;
  /** Nested structure returned by the kernel's /teams; used to render the form and parse user answers. */
  cachedTeams?: TeamOption[];
  /**
   * team_id chosen by the user in round 1 (only meaningful during pending_agent_task).
   * The round-2 form renders only that team's agents/tasks; the extractor also matches only within that team.
   */
  selectedTeamId?: string;
  /**
   * Current agent page in Claude Code pagination mode (0-based).
   *
   * Background: Claude Code's AskUserQuestion allows only 2–4 options per
   * question, so when a team has more than 3 agents they can't all be shown at
   * once. We reuse the existing "multi-round interception" mechanism: each page
   * renders 3 agents + 1 "More →" or "Don't bind this time" slot; clicking
   * "More" bumps pageIndex++ and re-sends the next form. See
   * docs/reports/2026-06-19-cc-form-mode-experiment.md §4.4.
   *
   * - Used only by Claude Code (agentSource="claude-code"); CodeBuddy goes
   *   through ask_followup_question with no 4-option limit, so no pagination.
   * - Only meaningful while status="pending_agent_task".
   * - Defaults to 0 (first page); each time the user picks "More", the handler
   *   increments it and re-sends the form.
   */
  agentPageIndex?: number;
  /** CC: agent_id chosen by the user in the agent_select stage (used for the pending_task_select stage). */
  selectedAgentId?: string;
  /** Resolved agent detail (cached after selection), used to inject context every request. */
  agentDetail?: AgentDetail | null;
  /** Resolved task detail (cached after selection), used to inject context every request. */
  taskDetail?: TaskDetail | null;
  /**
   * User explicitly chose to "skip" (don't bind this time). Status is set to
   * initialized to prevent repeated prompts, but agentDetail/taskDetail stay
   * null, so later requests only strip, never inject.
   */
  bypassed?: boolean;
  /**
   * Pagination page number exclusive to the codex client (0-based); written only
   * when agentSource="codex".
   *
   * Background: codex's request_user_input allows at most 3 options per question
   * (the client auto-appends an "other" option taking one slot, which the proxy
   * can't add itself). When candidates > 3, paginate at the 3-slot cap: each of
   * the first N-1 pages carries 2 real + "More...", the last 2~3 real.
   *
   * Independent of CC-side `agentPageIndex` — CC has its own 4-slot pagination
   * semantics (agent / task share one field, distinguished by stage), while
   * codex needs independent page numbers for team / agent / task; reusing would
   * cross-talk.
   *
   * ── who writes ──
   * The CB state machine bumps the corresponding field when it hits MORE on
   * agentSource==="codex" + reqCtx.codexAnswerInput (team spec 2026-08-08 codex
   * session-init refactor: MORE interception moved from codexHandler into the CB
   * state machine). CC / normal CB flows never write it.
   */
  codexPageIndex?: {
    teamPage?: number;
    agentPage?: number;
    taskPage?: number;
  };
  /**
   * Transient (not persisted): source hint set by SessionStore.getOrRecover
   * indicating which cache layer produced this state on the current turn.
   *
   * - `l1`: hot in-memory hit — hook-cache is almost certainly also warm in
   *   this process. Handler should NOT trigger prewarm.
   * - `l2a`: SessionRepo hit — same-process cache exists too (state promoted
   *   back to L1 in probeL2a); handler should NOT trigger prewarm.
   * - `l2b`: rebuilt from binding after L1+L2a miss — hook-cache may be
   *   cold (fresh pod / long dormant session). Handler SHOULD prewarm.
   * - `history-scan`: last-resort bypass reconstruction — hook-cache is
   *   also cold. Handler SHOULD prewarm.
   *
   * Consumed by handler.ts / anthropicHandler.ts to decide `justRegistered`
   * without triggering redundant network fetches on every warm turn.
   *
   * Not written by set()/upsert()/repo callers — only meaningful on the
   * getOrRecover return value; do not persist to L2a/L2b.
   */
  __recoverySource?: "l1" | "l2a" | "l2b" | "history-scan";

  /** Written when mem:session-reset fires; marks this init as a reset flow. */
  resetFlow?: boolean;
  /** Timestamp when mem:session-reset fired; used for cross-node consistency checks. */
  resetEpoch?: number;
}

/**
 * Nested structure from the control plane `/api/v1/proxy/resources`:
 *   teams[] → agents[]  +  tasks[]
 *
 * agents and tasks are the full lists under that team, shown side by side.
 * During session init the user freely picks an agent + task; the task_agents
 * association is managed by the page after init, so it doesn't affect the
 * option list shown during init.
 */
export interface TaskInTeam {
  task_id: string;
  task_name: string;
  /**
   * Marks this entry as a virtual task injected as the `config.defaultTaskId`
   * fallback (source: proxy) rather than a real task in the kernel. When the
   * form sees this field it skips the `(id-suffix)` concatenation and shows a
   * cleaner label — there's only one virtual task, so no name-collision
   * ambiguity.
   */
  isDefault?: boolean;
}

export interface AgentInTeam {
  agent_id: string;
  agent_name: string;
  description?: string;
}

export interface TeamOption {
  team_id: string;
  team_name: string;
  agents: AgentInTeam[];
  tasks: TaskInTeam[];
}

/** @deprecated Old flat structure, kept for old tests; new code uses TeamOption. */
export interface AgentOption {
  id: string;
  name: string;
  description?: string;
  team_id?: string;
}

/** @deprecated Old flat structure, kept for old tests; new code uses TaskInTeam. */
export interface TaskOption {
  id: string;
  name: string;
  description?: string;
}

/** Full Agent detail (fetched after selection) — content injected into system prompt. */
export interface AgentDetail {
  id: string;
  name: string;
  description?: string;
  /** The Agent's system-level prompt / persona, appended to system message. */
  prompt?: string;
}

/** Full Task detail (fetched after selection) — content injected into system prompt. */
export interface TaskDetail {
  id: string;
  name: string;
  description?: string;
  /** Optional structured goal/acceptance criteria text. */
  goal?: string;
}

/**
 * User-facing init data — agent + task selection (from dropdown).
 * team_id and user_id are sourced from the selected agent and the request
 * header respectively; not part of the user-facing form.
 */
export interface SessionInitData {
  agent_id: string;
  /** User-selected task (index into cachedTasks, or raw task_id string). */
  task_id?: string;
}

/** Full init data sent to register session. */
export interface SessionRegistrationData {
  team_id: string;
  agent_id: string;
  user_id: string;
  task_id?: string;
  session_id: string;
}

/**
 * Subset of the `POST /agent-sessions` response we consume.
 * The real backend returns more (created_at, updated_at, …) — we keep the
 * shape loose with `permissions` etc. optional so future fields don't break us.
 */
export interface SessionInfo {
  session_id: string;
  team_id: string;
  agent_id: string;
  user_id: string;
  task_id?: string;
  /** User's API key — stored so injectors can create MetadataClient for per-user kernel calls. */
  user_key?: string;
  /**
   * Kernel instance / space ID (e.g. `mem-example001`) extracted from the request
   * URL path `/proxy/<spaceId>/...`. Stored so injectors can build a
   * MetadataClient with the correct `x-tdai-service-id` header (kernel routes
   * tenants by this header — a static config value would return `invalid_user_key`).
   */
  space_id?: string;
  created_at?: string;
  expires_at?: string;
  identity_verified?: boolean;
  permissions?: {
    user_in_team?: boolean;
    user_in_task?: boolean;
    agent_assigned_to_task?: boolean;
    repo_in_team?: boolean;
  };
  fixed_asset_summary?: {
    count: number;
    total_est_tokens: number;
  };
}
