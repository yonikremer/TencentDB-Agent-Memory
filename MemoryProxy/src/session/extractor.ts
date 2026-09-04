/**
 * Identity extractor — picks agent + task selection from user reply.
 *
 * V3: Supports:
 *   1. ask_followup_question option text (user clicked a button) — matched by name
 *   2. Numeric selection ("agent: 1\ntask: 2")
 *   3. Raw ID input ("agent: agent_bug_fixer")
 *
 * The historical LLM-based extraction fallback was removed — when structured
 * parsing can't match, callers should bump the retry counter and bypass.
 */

import type { SessionInitData, AgentOption, TaskOption, TeamOption } from "./types.js";
import { PATH_SEP, SKIP_LABEL, MORE_LABEL } from "./form.js";

// ── Path A: Match from option text (ask_followup_question click result) ────────

const SKIP_RE = /跳过|不关联|skip/i;

/** Bypass marker: the user chose "do not associate this time", so the whole session-init is skipped directly. */
export const BYPASS_MARKER = "__bypass__" as const;

/**
 * Paging "More" marker: in the Claude Code paging flow, clicking "More →" makes the
 * handler bump agentPageIndex by 1 and resend the next page of the form. The state
 * stays pending_agent_task, which does not count as a retry.
 */
export const MORE_MARKER = "__more__" as const;

/**
 * Parse CodeBuddy's `<question_answer>` XML that is generated when the user
 * clicks an option in an `ask_followup_question` form. This XML is sent back
 * as the next user message. Example:
 *
 *   <question_answer>
 *   <title>...</title>
 *   <questions>
 *   <question_item id="agent">
 *   <question>Please select the Agent to use for this session:</question>
 *   <answers>
 *   Bug Fixer — automatically locates and fixes code defects
 *   </answers>
 *   </question_item>
 *   <question_item id="task">...</question_item>
 *   </questions>
 *   </question_answer>
 *
 * The `id` echoes whatever we passed in the tool_call args (we use "agent"/"task"),
 * but the model may also use generic ids like "q1"/"q2", so we accept both.
 * Returns the raw answer text per slot, or null if no XML form is present.
 */
function parseQuestionAnswerXml(
  content: string,
): {
  teamAnswer?: string;
  agentAnswer?: string;
  taskAnswer?: string;
} | null {
  if (!content.includes("<question_answer") && !content.includes("<question_item")) {
    return null;
  }

  const result: { teamAnswer?: string; agentAnswer?: string; taskAnswer?: string } = {};
  const itemRe =
    /<question_item\s+id="([^"]+)"\s*>[\s\S]*?<answers>\s*([\s\S]*?)\s*<\/answers>/g;
  let m: RegExpExecArray | null;
  let index = 0;
  // First scan all question_items to determine how many questions there are in total.
  // Round 1 form has 1 question (team); round 2 form has 2 (agent + task).
  const allIds: string[] = [];
  const idRe = /<question_item\s+id="([^"]+)"\s*>/g;
  let idM: RegExpExecArray | null;
  while ((idM = idRe.exec(content)) !== null) {
    allIds.push(idM[1].trim().toLowerCase());
  }
  const isSingleQuestion = allIds.length === 1;

  while ((m = itemRe.exec(content)) !== null) {
    const id = m[1].trim().toLowerCase();
    const answer = m[2].trim();
    if (!answer) {
      index++;
      continue;
    }
    // Known ids: team / agent / task; unknown ids fall back to the positional index
    if (id === "team") {
      result.teamAnswer = result.teamAnswer ?? answer;
    } else if (id === "agent") {
      result.agentAnswer = result.agentAnswer ?? answer;
    } else if (id === "task") {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (id === "q1") {
      if (isSingleQuestion) {
        // Round 1 form has only 1 question — q1 is team
        result.teamAnswer = result.teamAnswer ?? answer;
      } else {
        // Round 2 form has 2 questions — q1 is agent
        result.agentAnswer = result.agentAnswer ?? answer;
      }
    } else if (id === "q2" && !isSingleQuestion) {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (index === 0 && !result.teamAnswer && !result.agentAnswer) {
      // Fallback: the first question with an unknown id goes to team
      result.teamAnswer = answer;
    }
    index++;
  }

  return result.teamAnswer || result.agentAnswer || result.taskAnswer ? result : null;
}

/**
 * Round 1 extraction: identify the selected team_id from the user's reply.
 *
 * The parsing strategy branches on agentSource:
 * - **CodeBuddy**: the user's choice lives in a `role: "user"` message
 *   (`<question_answer>` XML or plain text), so parse the XML + substring fallback.
 *   No JSON parsing, to avoid misreading an empty tool-call shell.
 * - **Claude Code**: the user's choice lives in a `role: "tool"` message
 *   (`multi_question_result` JSON or `AskUserQuestion` tool_result), so parse the
 *   JSON + substring fallback.
 *
 * @param agentSource  "codebuddy" | "claude-code"
 * @returns team_id, or BYPASS_MARKER (user chose "do not associate this time"), or null (unrecognized)
 */
export function extractTeamFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  agentSource: string = "codebuddy",
): string | null {
  if (cachedTeams.length === 0) return null;

  let teamText: string | null = null;

  // 1) JSON parsing: both CodeBuddy (multi_question_result in tool message) and
  //    Claude Code (AskUserQuestion tool_result / multi_question_result).
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      // AskUserQuestion tool_result: { answers: { "q": "label" } }
      if (parsed.answers && typeof parsed.answers === "object") {
        const answers = parsed.answers as Record<string, string>;
        for (const val of Object.values(answers)) {
          if (typeof val === "string" && val.trim()) {
            teamText = val.trim();
            break;
          }
        }
      }
      // multi_question_result envelope (both CodeBuddy and Claude Code)
      if (!teamText) {
        const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
        if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
          for (const q of mqr.questions) {
            if (!q || typeof q !== "object") continue;
            const qo = q as Record<string, unknown>;
            const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
            let val: string | null = null;
            if (typeof cand === "string") val = cand.trim() || null;
            else if (Array.isArray(cand)) {
              const f = cand.find((x) => typeof x === "string" && x.trim());
              if (typeof f === "string") val = f.trim();
            }
            if (val) { teamText = val; break; }
          }
        }
      }
    }
  } catch {
    /* not JSON — try XML / substring fallback */
  }

  // 2) XML parsing: CodeBuddy <question_answer> in user message.
  if (!teamText) {
    const xml = parseQuestionAnswerXml(content);
    if (xml) {
      teamText = xml.teamAnswer ?? null;
    }
  }

  // Detect "do not associate this time" → bypass directly (only judged once teamText
  // is extracted, so "skip / do not associate" inside the form option text in content
  // won't spuriously trigger bypass)
  if (teamText && (teamText.includes(SKIP_LABEL) || SKIP_RE.test(teamText.trim()))) {
    return BYPASS_MARKER;
  }

  // Matching strategy (team option label format: "team name (id trailing 8 chars)"):
  //   1. Exact match on the full label (including the id suffix)
  //   2. Exact match on team_name alone
  //   3. Match the "(xxxxxxxx)" part by id suffix
  //   4. substring fallback (by name length, descending)
  const hay = teamText ?? content;
  const trimmed = hay.trim();

  const exactFull = cachedTeams.find(
    (t) => `${t.team_name} (${t.team_id.slice(-8)})` === trimmed,
  );
  if (exactFull) return exactFull.team_id;

  const exactName = cachedTeams.find((t) => t.team_name === trimmed);
  if (exactName) return exactName.team_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = cachedTeams.find((t) => t.team_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.team_id;
  }

  const sorted = [...cachedTeams].sort((a, b) => b.team_name.length - a.team_name.length);
  for (const t of sorted) {
    if (hay.includes(t.team_name)) return t.team_id;
  }
  for (const t of cachedTeams) {
    if (hay.includes(t.team_id.slice(-8))) return t.team_id;
  }
  return null;
}

/**
 * Match an agent within a given team. The round 2 form already pins the team, so there
 * is no chance of a cross-team mismatch.
 *
 * Matching strategy (agent option label format: "agent name (id trailing 8 chars)"):
 *   1. Exact match on the full label (including the id suffix)
 *   2. Exact match on agent_name alone
 *   3. Match the "(xxxxxxxx)" part by id suffix
 *   4. substring fallback (by agent_name length descending, to avoid short-name false matches)
 */
function matchAgentInTeam(text: string, team: TeamOption): string | null {
  const trimmed = text.trim();

  const exactFull = team.agents.find(
    (a) => `${a.agent_name} (${a.agent_id.slice(-8)})` === trimmed,
  );
  if (exactFull) return exactFull.agent_id;

  const exactName = team.agents.find((a) => a.agent_name === trimmed);
  if (exactName) return exactName.agent_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.agents.find((a) => a.agent_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.agent_id;
  }

  const sorted = [...team.agents].sort((a, b) => b.agent_name.length - a.agent_name.length);
  for (const a of sorted) {
    if (text.includes(a.agent_name)) return a.agent_id;
  }
  for (const a of team.agents) {
    if (text.includes(a.agent_id.slice(-8))) return a.agent_id;
  }
  return null;
}

/**
 * Match a task within a given team. Task option label format: "task name (id trailing 8 chars)".
 *   - First try an exact match on the full label (including the id suffix)
 *   - Then try matching task_name alone
 *   - substring fallback (by name length descending, longer names first)
 */
function matchTaskInTeam(
  text: string,
  team: TeamOption,
  _hintAgentId?: string,
): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();

  // 1) Exact match on the full label: "task name (xxxxxxxx)"
  const exactFull = team.tasks.find((t) => `${t.task_name} (${t.task_id.slice(-8)})` === trimmed);
  if (exactFull) return exactFull.task_id;

  // 2) Exact match on task_name alone (may have several same-name entries; return the first)
  const exactName = team.tasks.find((t) => t.task_name === trimmed);
  if (exactName) return exactName.task_id;

  // 3) Exact match on the "(xxxxxxxx)" part by id suffix
  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.tasks.find((t) => t.task_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.task_id;
  }

  // 4) substring fallback: by task_name length descending
  const sorted = [...team.tasks].sort((a, b) => b.task_name.length - a.task_name.length);
  for (const t of sorted) {
    if (trimmed.includes(t.task_name)) return t.task_id;
  }

  // 5) Loose match: any 8-character substring of trimmed matching the id suffix
  for (const t of team.tasks) {
    if (trimmed.includes(t.task_id.slice(-8))) return t.task_id;
  }

  return undefined;
}

/** @deprecated Legacy flat structure, kept only for old tests to call. */
function matchAgent(text: string, agents: AgentOption[]): string | null {
  const exact = agents.find((a) => a.name === text);
  if (exact) return exact.id;
  const candidates = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const a of candidates) {
    if (text.includes(a.name)) return a.id;
  }
  return null;
}

/** @deprecated Legacy flat structure, kept only for old tests to call. */
function matchTask(text: string, tasks: TaskOption[]): string | undefined {
  const exact = tasks.find((t) => t.name === text);
  if (exact) return exact.id;
  const candidates = [...tasks].sort((a, b) => b.name.length - a.name.length);
  for (const t of candidates) {
    if (text.includes(t.name)) return t.id;
  }
  return undefined;
}

/**
 * Round 2 extraction: identify agent + task from the user's reply, **strictly limited
 * to the already-selected team**. Cross-team mismatches are ruled out at the protocol
 * layer (the round 1 form already pins the team).
 *
 * The parsing strategy branches on agentSource:
 * - **CodeBuddy**: the user's choice lives in a `role: "user"` message, so parse the
 *   `<question_answer>` XML + substring fallback. No JSON parsing, to avoid misreading
 *   an empty tool-call shell.
 * - **Claude Code**: the user's choice lives in a `role: "tool"` message
 *   (`multi_question_result` JSON or `AskUserQuestion` tool_result), so parse the
 *   JSON + substring fallback.
 *
 * @param agentSource  "codebuddy" | "claude-code"
 * @returns `{ agent_id: BYPASS_MARKER }` if the user chose "do not associate this time".
 */
export function extractFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
  agentSource: string = "codebuddy",
): SessionInitData | null {
  // Round 2 parsing requires an already-selected team; otherwise treat as invalid state.
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;

  let agentText: string | null = null;
  let taskText: string | null = null;

  // 1) JSON parsing: both CodeBuddy (multi_question_result in tool message) and
  //    Claude Code (AskUserQuestion tool_result / multi_question_result).
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      // AskUserQuestion tool_result: { answers: { "q": "label" } }
      if (!agentText && !taskText && parsed.answers && typeof parsed.answers === "object") {
        const answers = parsed.answers as Record<string, string>;
        for (const val of Object.values(answers)) {
          const trimmed = val.trim();
          if (!trimmed) continue;
          if (matchAgentInTeam(trimmed, team)) {
            agentText = trimmed;
            break;
          }
        }
      }
      // multi_question_result envelope (both CodeBuddy and Claude Code)
      if (!agentText && !taskText) {
        const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
        if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
          const pickAnswer = (q: Record<string, unknown>): string | null => {
            const cand = q.answer ?? q.answers ?? q.selected ?? q.selectedOption ?? q.value;
            if (cand == null) return null;
            if (typeof cand === "string") return cand.trim() || null;
            if (Array.isArray(cand)) {
              const first = cand.find((x) => typeof x === "string" && x.trim());
              return typeof first === "string" ? first.trim() : null;
            }
            return null;
          };
          for (const q of mqr.questions) {
            if (!q || typeof q !== "object") continue;
            const qo = q as Record<string, unknown>;
            const id = typeof qo.id === "string" ? qo.id.toLowerCase() : "";
            const ans = pickAnswer(qo);
            if (!ans) continue;
            if (id === "agent" && !agentText) agentText = ans;
            else if (id === "task" && !taskText) taskText = ans;
          }
        }
      }
    }
  } catch {
    /* not JSON — try XML / substring fallback */
  }

  // 2) XML parsing: CodeBuddy <question_answer> in user message.
  if (!agentText && !taskText) {
    const xml = parseQuestionAnswerXml(content);
    if (xml) {
      agentText = xml.agentAnswer ?? null;
      taskText = xml.taskAnswer ?? null;
    }
  }

  // Detect that the Agent selected "More →" → page (only judged once agentText is
  // extracted, so a label inside the form option text in content won't spuriously trigger it)
  if (agentText && agentText.includes(MORE_LABEL)) {
    return { agent_id: MORE_MARKER };
  }

  // Detect that the Agent selected "do not associate this time" → bypass (same as above, only judged when agentText was clearly extracted)
  if (agentText && (agentText.includes(SKIP_LABEL) || SKIP_RE.test(agentText.trim()))) {
    return { agent_id: BYPASS_MARKER };
  }

  // Resolve agent —— match strictly within team.agents only
  let agentId: string | null = null;
  if (agentText) agentId = matchAgentInTeam(agentText, team);
  if (!agentId) agentId = matchAgentInTeam(content, team);
  if (!agentId) return null;

  // Resolve task —— match within the same team; return undefined on an explicit skip
  let taskId: string | undefined;
  const taskHay = taskText ?? content;
  if (!SKIP_RE.test(taskHay)) {
    taskId = matchTaskInTeam(taskHay, team, agentId);
  }

  return { agent_id: agentId, task_id: taskId };
}

// ── Path B: Structured Matching ────────────────────────────────────────────────

/** Extract agent_id and optional task from user reply (regex-based). */
export function extractStructured(content: string): SessionInitData | null {
  const agentMatch = content.match(/agent\s*[:：=]\s*(\S+)/i);
  if (!agentMatch) return null;

  const agent_id = agentMatch[1].trim();
  if (!agent_id) return null;

  let task_id: string | undefined;
  const taskMatch = content.match(/task\s*[:：=]\s*(\S+)/i);
  if (taskMatch && taskMatch[1] !== "0" && taskMatch[1].toLowerCase() !== "skip") {
    task_id = taskMatch[1].trim();
  }

  return { agent_id, task_id };
}

/**
 * Resolve user's agent selection from a possibly numeric / partial label.
 * Numbers index into the selected team's agents (1-based); strings are returned as-is.
 */
export function resolveAgent(
  rawAgentId: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  // Resolve via a 1-based index only when rawAgentId is a **pure number** (a rank reply such as "1" / "2").
  // Never use parseInt to tolerate a leading digit —— ULIDs start with "01...", so parseInt would yield 1
  // and wrongly map every real agent_id to team.agents[0] (the team's first agent).
  if (team && /^\d+$/.test(rawAgentId)) {
    const num = parseInt(rawAgentId, 10);
    if (num > 0 && num <= team.agents.length) {
      return team.agents[num - 1].agent_id;
    }
  }
  return rawAgentId;
}

/**
 * Resolve user's task selection from a possibly numeric / raw value.
 * Numbers index into the effective team's task list (1-based, agentHintId preferred);
 * strings are returned as-is.
 */
export function resolveTask(
  rawTaskId: string | undefined,
  cachedTeams: TeamOption[],
  agentHintId?: string,
  selectedTeamId?: string,
): string | undefined {
  if (!rawTaskId) return undefined;
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  // Same as resolveAgent: only accept a pure-numeric rank, so parseInt won't misread the leading "0" of an "01KV..." prefix.
  if (team && /^\d+$/.test(rawTaskId)) {
    const num = parseInt(rawTaskId, 10);
    if (num > 0 && num <= team.tasks.length) {
      return team.tasks[num - 1].task_id;
    }
  }
  return rawTaskId;
}

// ── Combined Interface ─────────────────────────────────────────────────────────

/**
 * Extract identity purely via the engineered structured parser. The historical
 * LLM-based `extractViaLLM` fallback was removed — when structured parsing
 * fails, callers must bump the retry counter and eventually bypass session
 * init rather than hand the guessing job to an LLM.
 */
export async function extractIdentity(
  content: string,
): Promise<SessionInitData | null> {
  return extractStructured(content);
}
