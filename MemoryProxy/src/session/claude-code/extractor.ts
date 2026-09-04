/**
 * Claude Code Session Init — Extractor.
 *
 * Parses the user's reply from the `AskUserQuestion` form.
 * The Claude Code user's choice is in the `role: "tool"` message, formatted as JSON tool_result.
 *
 * Supported reply formats:
 *   1. AskUserQuestion tool_result: `{ answers: { "q": "label" } }`
 *   2. multi_question_result envelope
 *   3. Plain text label (the string returned by the CLI after the user selects an option)
 *
 * Contains no CodeBuddy XML parsing logic.
 */

import type { SessionInitData, TeamOption } from "../types.js";
import { SKIP_LABEL, MORE_LABEL, ASSET_CONFIRM_YES, ASSET_CONFIRM_NO } from "./form.js";

// ── Markers ────────────────────────────────────────────────────────────────────

const SKIP_RE = /跳过|不关联|skip|do not associate/i;
export const BYPASS_MARKER = "__bypass__" as const;
export const MORE_MARKER = "__more__" as const;

/**
 * Extracts the asset_confirm choice from the user's reply.
 * Returns true=yes (associate assets), false=no (bypass), null=unrecognized.
 *
 * Format compatibility:
 *   1. Exact options: "Yes, associate team assets" / "No, do not associate this time" / "是，关联团队资产" / "否，本次不关联"
 *   2. Q&A format: "Your questions have been answered: \"Q?\"=\"A\"."
 *   3. "Chat about this" / free text → falls back to returning null (bypass)
 */
export function extractAssetConfirm(content: string): boolean | null {
  const answer = extractAnswerFromJson(content);
  if (!answer) return null;

  // First check if it's a refusal/skip/free text (Chat about this / declined / rejected)
  // Added Chinese "non-answer" pattern: the user might have entered content unrelated to the question directly
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions|declined/i.test(answer)) {
    return null;
  }

  // Claude Code return format might include the full Q&A context, like:
  // "Your questions have been answered: \"Question?\"=\"Answer\"."
  // Extract the content in quotes after the last = as the actual answer
  let answerOnly = answer;
  const eqMatch = answer.match(/="([^"]+)"[^"]*$/);
  if (eqMatch) {
    answerOnly = eqMatch[1];
  }

  // Safety valve: if the extracted content exceeds 80 characters, it's highly likely not a pure user answer but contains the full Q&A text
  // In this case, refuse to go through the loose regex to prevent misjudging "whether to associate" in the question as a "yes"
  // (Only exact match ASSET_CONFIRM_YES / ASSET_CONFIRM_NO can pass)
  const allowLoosePattern = answerOnly.length <= 80;

  // Exact match: full option text (English or Chinese)
  if (answerOnly.includes(ASSET_CONFIRM_YES) || answerOnly.includes("是，关联团队资产")) {
    return true;
  }
  if (answerOnly.includes(ASSET_CONFIRM_NO) || answerOnly.includes("否，本次不关联")) {
    return false;
  }

  if (allowLoosePattern) {
    // Loose "yes" match: must start with "是", "确认", "yes", or "y"
    if (/^(?:是|确认|yes|y)(?:[，,\s]|$)/i.test(answerOnly.trim())) {
      return true;
    }
    // Loose "no" match
    if (/^(?:否|不[，,\s]|跳过|skip|no|n)(?:[，,\s]|$)/i.test(answerOnly.trim())) {
      return false;
    }
  }

  return null;
}

// ── JSON parsing helpers ──────────────────────────────────────────────────────────

/**
 * Extracts answer text from Claude Code tool_result JSON.
 * Supported formats:
 *   - `{ answers: { "q": "label" } }` (AskUserQuestion standard)
 *   - `{ type: "multi_question_result", questions: [...] }`
 *   - Plain text string (free text input by user)
 */
function extractAnswerFromJson(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "string") return parsed.trim() || null;
    if (typeof parsed !== "object" || parsed === null) return null;

    // AskUserQuestion tool_result: { answers: { "q": "label" } }
    if (parsed.answers && typeof parsed.answers === "object") {
      const answers = parsed.answers as Record<string, string>;
      for (const val of Object.values(answers)) {
        if (typeof val === "string" && val.trim()) {
          return val.trim();
        }
      }
    }

    // multi_question_result envelope
    const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
    if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
      for (const q of mqr.questions) {
        if (!q || typeof q !== "object") continue;
        const qo = q as Record<string, unknown>;
        const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
        if (typeof cand === "string" && cand.trim()) return cand.trim();
        if (Array.isArray(cand)) {
          const f = cand.find((x) => typeof x === "string" && x.trim());
          if (typeof f === "string") return f.trim();
        }
      }
    }

    return null;
  } catch {
    // Not JSON — Claude Code tool_result is often a concatenated string format:
    //   Your questions have been answered: "<question>"="<answer>".
    // Only take the answer inside ="..."; this way words like "skip / skippable"
    // appearing in the question text won't pollute the downstream SKIP_RE match (regression of session1.json Bug).
    const eq = content.match(/="([^"]+)"[^"]*$/);
    if (eq) return eq[1].trim() || null;
    return content.trim() || null;
  }
}

/**
 * Extracts agent and task answers from JSON (round 2 multi-question scenario).
 */
function extractAgentTaskFromJson(content: string): { agentText: string | null; taskText: string | null } {
  let agentText: string | null = null;
  let taskText: string | null = null;

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) {
      const raw = content.trim();
      const eq = raw.match(/="([^"]+)"[^"]*$/);
      return { agentText: (eq ? eq[1].trim() : raw) || null, taskText: null };
    }

    // AskUserQuestion: { answers: { "q": "label" } }
    if (parsed.answers && typeof parsed.answers === "object") {
      const answers = parsed.answers as Record<string, string>;
      for (const val of Object.values(answers)) {
        if (typeof val === "string" && val.trim()) {
          // CC form round 2 only has 1 question (agent), the first non-empty answer is the agent
          if (!agentText) agentText = val.trim();
          break;
        }
      }
    }

    // multi_question_result envelope
    if (!agentText && !taskText) {
      const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
      if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
        for (const q of mqr.questions) {
          if (!q || typeof q !== "object") continue;
          const qo = q as Record<string, unknown>;
          const id = typeof qo.id === "string" ? qo.id.toLowerCase() : "";
          const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
          let val: string | null = null;
          if (typeof cand === "string") val = cand.trim() || null;
          else if (Array.isArray(cand)) {
            const f = cand.find((x) => typeof x === "string" && x.trim());
            if (typeof f === "string") val = f.trim();
          }
          if (!val) continue;
          if (id === "agent" && !agentText) agentText = val;
          else if (id === "task" && !taskText) taskText = val;
        }
      }
    }
  } catch {
    // Not JSON — compatible with Claude Code concatenated string format `…"question"="answer".`
    const raw = content.trim();
    const eq = raw.match(/="([^"]+)"[^"]*$/);
    agentText = (eq ? eq[1].trim() : raw) || null;
  }

  return { agentText, taskText };
}

// ── Team Match ──────────────────────────────────────────────────────────────────

/**
 * Round 1 extraction: Identifies the selected team_id from the user's reply.
 * Claude Code: User choice is in the `role: "tool"` message, goes through JSON parsing.
 */
export function extractTeamFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
): string | null {
  if (cachedTeams.length === 0) return null;

  // First check if it's a refusal/skip (Chat about this / declined)
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions/i.test(content)) {
    return null;
  }

  const teamText = extractAnswerFromJson(content);

  // Detect "do not associate this time" → bypass
  if (teamText && (teamText.includes(SKIP_LABEL) || SKIP_RE.test(teamText.trim()))) {
    return BYPASS_MARKER;
  }

  // Match strategy
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

// ── Agent / Task Match ─────────────────────────────────────────────────────────

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

function matchTaskInTeam(text: string, team: TeamOption): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();

  const exactFull = team.tasks.find((t) => `${t.task_name} (${t.task_id.slice(-8)})` === trimmed);
  if (exactFull) return exactFull.task_id;

  const exactName = team.tasks.find((t) => t.task_name === trimmed);
  if (exactName) return exactName.task_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.tasks.find((t) => t.task_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.task_id;
  }

  const sorted = [...team.tasks].sort((a, b) => b.task_name.length - a.task_name.length);
  for (const t of sorted) {
    if (trimmed.includes(t.task_name)) return t.task_id;
  }
  for (const t of team.tasks) {
    if (trimmed.includes(t.task_id.slice(-8))) return t.task_id;
  }
  return undefined;
}

/**
 * task_select phase extraction: Only parses the label in answers instead of the full tool_result text.
 * Here we no longer reuse the old extractFromOptionText path — that path passes the original tool_result text
 * as a fallback to matchTaskInTeam, which would misjudge the task explicitly selected by the user as bypass
 * because the question text ("…(skippable):") contains "skip" (historical Bug).
 *
 * Returns:
 *   - task_id string: match;
 *   - MORE_MARKER: User clicked "More →", caller turns the page;
 *   - BYPASS_MARKER: declined / empty reply / explicit skip compatible with old forms;
 *   - null: identify got an answer but failed to match team.tasks (caller treats as unrecognized → bypass).
 *
 * defaultTaskId fallback association is implemented via header injection by fetchTeamsAndAgents — when the user selects
 * the "do not associate task this time" label, it hits the virtual entry in matchTaskInTeam and returns defaultTaskId,
 * no need for a separate branch here.
 */
export function extractTaskFromOptionText(
  content: string,
  team: import("../types.js").TeamOption | undefined,
): string | typeof MORE_MARKER | typeof BYPASS_MARKER | null {
  // declined / rejected → bypass (consistent with other phases)
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions/i.test(content)) {
    return BYPASS_MARKER;
  }
  if (!team) return BYPASS_MARKER;

  const answer = extractAnswerFromJson(content);
  if (!answer) return BYPASS_MARKER;

  // Turn page
  if (answer.includes(MORE_LABEL)) return MORE_MARKER;

  // Compatible with old forms: User manually typed "skip / skip / do not associate" → explicit bypass. Note: The label
  // for the defaultTaskId virtual entry is "do not associate task this time", which SKIP_RE will match, so try normal match
  // first before going to bypass.
  const taskId = matchTaskInTeam(answer, team);
  if (taskId) return taskId;

  if (SKIP_RE.test(answer.trim())) {
    return BYPASS_MARKER;
  }

  return null;
}

/**
 * Round 2 extraction: Identifies agent + task from the user's reply.
 * Claude Code: goes through JSON parsing. Only matches within the selected team.
 */
export function extractFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): SessionInitData | null {
  // First check if it's a refusal/skip (Chat about this / declined)
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions/i.test(content)) {
    return null;
  }

  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;

  const { agentText, taskText } = extractAgentTaskFromJson(content);

  // Detect "More →" → turn page
  if (agentText && agentText.includes(MORE_LABEL)) {
    return { agent_id: MORE_MARKER };
  }

  // Detect "do not associate this time" → bypass
  if (agentText && (agentText.includes(SKIP_LABEL) || SKIP_RE.test(agentText.trim()))) {
    return { agent_id: BYPASS_MARKER };
  }

  // Resolve agent
  let agentId: string | null = null;
  if (agentText) agentId = matchAgentInTeam(agentText, team);
  if (!agentId) agentId = matchAgentInTeam(content, team);
  if (!agentId) return null;

  // Resolve task
  let taskId: string | undefined;
  const taskHay = taskText ?? content;
  if (!SKIP_RE.test(taskHay)) {
    taskId = matchTaskInTeam(taskHay, team);
  }

  return { agent_id: agentId, task_id: taskId };
}

// ── Structured / LLM fallback ──────────────────────────────────────────────────

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

// ── Resolvers ──────────────────────────────────────────────────────────────────

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
  if (team && /^\d+$/.test(rawAgentId)) {
    const num = parseInt(rawAgentId, 10);
    if (num > 0 && num <= team.agents.length) {
      return team.agents[num - 1].agent_id;
    }
  }
  return rawAgentId;
}

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
  if (team && /^\d+$/.test(rawTaskId)) {
    const num = parseInt(rawTaskId, 10);
    if (num > 0 && num <= team.tasks.length) {
      return team.tasks[num - 1].task_id;
    }
  }
  return rawTaskId;
}
