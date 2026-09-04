/**
 * CodeBuddy Session Init — Extractor.
 *
 * Parses the user's response from the `ask_followup_question` form.
 *
 * ── Why does it look like parsing XML, yet works for multi-round cross-team forms? ──
 *
 * Currently, it only parses `<question_answer>` XML (CodeBuddy old format).
 * In practice, CodeBuddy's actual write-back format is `multi_question_result` JSON inside `role: "tool"` messages
 * (see the capture format in the header comment of cleaner.ts). However, the extractor's substring fallback matching
 * "coincidentally" matches the team/agent/task names within unrelated user message text, enabling session init to succeed by chance.
 * This is a fragile dependency, not a precise parse. For reliable extraction, a JSON parsing path must be added.
 *
 * Contains no Claude Code logic (does not parse JSON tool_result).
 */

import type { SessionInitData, TeamOption } from "../types.js";
import { SKIP_LABEL, PATH_SEP, ASSET_CONFIRM_YES, ASSET_CONFIRM_NO } from "./form.js";

// ── Markers ────────────────────────────────────────────────────────────────────

const SKIP_RE = /跳过|不关联|skip|do not associate/i;
export const BYPASS_MARKER = "__bypass__" as const;

// ── opencode tool-result unwrapping ───────────────────────────────────────────────
//
// After opencode CLI's native `question` tool receives the user selection, it returns the answer as plain text
// to the model as a tool-result, formatted as:
//   User has answered your questions: "question description..."="user answer"[, "question 2"="answer 2"]
//
// The **question description often contains words like "skip" or "do not associate"** (since we show the user
// a "skip" option in the form). If we feed the entire content directly to extractAgentOnly /
// extractTaskOnly, the first line's SKIP_RE.test will hit the "skip" in the question description →
// falsely identifying it as BYPASS_MARKER, causing the agent_select / task_select stages to never complete.
//
// Fix: Unwrap at the entry of these extractors—only extract all the answer segments to the right of `="..."`,
// concatenate them, and then proceed with the evaluation. Non-opencode scenarios (CB XML / codex raw text / wb direct
// answer) do not have this wrapper layer; the helper returns null, falling back to the original content path.
//
// The asset_confirm scenario does not use this helper because extractAssetConfirm uses an allowlist approach of
// "look for positive markers first, then negative markers", so the word "skip" in the question description is naturally harmless.
//
// Match the value in `="value"`—note that the value may contain inner quotes escaped by opencode.
// In practice (2026-08-19), when the opencode client encounters inner quotes, it outputs escaped
// `\"` or passes through full-width quotes `"`. For maximum compatibility, a simple `[^"]*` match suffices (covering
// all labels in our form.ts—pure label text contains no bare English quotes).
function extractOpencodeAnswers(content: string): string | null {
  if (!content.includes("User has answered your questions:")) return null;
  const answers: string[] = [];
  const re = /"[^"]*"="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1]) answers.push(m[1]);
  }
  return answers.length > 0 ? answers.join(" | ") : null;
}

/**
 * Extract asset_confirm selection from user reply.
 * Returns true=yes (associate assets), false=no (bypass), null=unrecognized.
 */
export function extractAssetConfirm(content: string): boolean | null {
  // XML parsing
  const xml = parseQuestionAnswerXml(content);
  const answer = xml?.teamAnswer ?? xml?.agentAnswer ?? xml?.taskAnswer ?? content;

  if (
    answer.includes(ASSET_CONFIRM_YES) ||
    answer.includes("是，关联团队资产") ||
    /^(?:yes|y|是|确认)/i.test(answer.trim()) ||
    /是.*关联|关联.*是|确认.*关联/i.test(answer)
  ) {
    return true;
  }
  if (
    answer.includes(ASSET_CONFIRM_NO) ||
    answer.includes("否，本次不关联") ||
    /^(?:no|n|否|不|跳过|skip)/i.test(answer.trim()) ||
    /否.*不关联|不关联.*否|本次不关联/i.test(answer)
  ) {
    return false;
  }
  return null;
}

// ── XML Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse CodeBuddy's `<question_answer>` XML from user message.
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

  // First scan all question_items to determine the total count (round 1: 1, round 2: 2)
  const allIds: string[] = [];
  const idRe = /<question_item\s+id="([^"]+)"\s*>/g;
  let idM: RegExpExecArray | null;
  while ((idM = idRe.exec(content)) !== null) {
    allIds.push(idM[1].trim().toLowerCase());
  }
  const isSingleQuestion = allIds.length === 1;

  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = itemRe.exec(content)) !== null) {
    const id = m[1].trim().toLowerCase();
    const answer = m[2].trim();
    if (!answer) { index++; continue; }

    if (id === "team") {
      result.teamAnswer = result.teamAnswer ?? answer;
    } else if (id === "agent") {
      result.agentAnswer = result.agentAnswer ?? answer;
    } else if (id === "task") {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (id === "q1") {
      if (isSingleQuestion) {
        result.teamAnswer = result.teamAnswer ?? answer;
      } else {
        result.agentAnswer = result.agentAnswer ?? answer;
      }
    } else if (id === "q2" && !isSingleQuestion) {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (index === 0 && !result.teamAnswer && !result.agentAnswer) {
      result.teamAnswer = answer;
    }
    index++;
  }

  return result.teamAnswer || result.agentAnswer || result.taskAnswer ? result : null;
}

// ── Team Matching ──────────────────────────────────────────────────────────────────

/**
 * Round 1 Extraction: Identify the selected team_id from the user's response.
 * CodeBuddy: User selection is in a `role: "user"` message, processed via `<question_answer>` XML parsing.
 */
export function extractTeamFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
): string | null {
  if (cachedTeams.length === 0) return null;

  // opencode: Unwrap tool-result to prevent "skip" keywords in the question description from triggering false SKIPs.
  // See the header comment of extractOpencodeAnswers.
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;

  let teamText: string | null = null;

  // XML parsing: CodeBuddy <question_answer> in user message.
  const xml = parseQuestionAnswerXml(content);
  if (xml) {
    teamText = xml.teamAnswer ?? null;
  }

  // Matching strategy (team option label format: "team name (id trailing 8 chars)")
  const hay = teamText ?? content;
  const trimmed = hay.trim();

  // Detect "do not associate this time" / SKIP_RE → bypass.
  // (P1-4) Earlier, SKIP_RE was only evaluated on teamText parsed from XML, and non-XML content wouldn't reach it;
  // In the real codex CLI, codexFormAnswersAsMessages extracts JSON answers into bare content
  // (e.g., "skip"), resulting in SKIP_RE never triggering → falls through to normal team name matching → misses →
  // treated as "unrecognized" by the upper layer (init.ts pending_team_select) incrementing attemptCount, forcing bypass
  // only after 3 maxRetries. Align with extractAgentOnly / extractTaskOnly: unconditionally test SKIP_RE before formal matching.
  if (SKIP_RE.test(trimmed) || trimmed.includes(SKIP_LABEL)) {
    return BYPASS_MARKER;
  }

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

// ── Agent / Task Matching ─────────────────────────────────────────────────────────

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
 * Round 2 Extraction: Identify agent + task from the user's response, **strictly scoped to the selected team**.
 * CodeBuddy: Processed via `<question_answer>` XML parsing.
 */
export function extractFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): SessionInitData | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;

  // opencode: 剥壳 tool-result 包裹（见 extractOpencodeAnswers 头部）。
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;

  let agentText: string | null = null;
  let taskText: string | null = null;

  // XML parsing: CodeBuddy <question_answer> in user message.
  const xml = parseQuestionAnswerXml(content);
  if (xml) {
    agentText = xml.agentAnswer ?? null;
    taskText = xml.taskAnswer ?? null;
  }

  // Detect if Agent was selected as "do not associate this time" → bypass
  if (agentText && (agentText.includes(SKIP_LABEL) || SKIP_RE.test(agentText.trim()))) {
    return { agent_id: BYPASS_MARKER };
  }

  // Resolve agent
  let agentId: string | null = null;
  if (agentText) agentId = matchAgentInTeam(agentText, team);
  if (!agentId) agentId = matchAgentInTeam(content, team);
  if (!agentId) return null;

  // Resolve task. defaultTaskId fallback is implemented via header injection in fetchTeamsAndAgents:
  // User selecting the "do not associate task this time" label hits the virtual entry in matchTaskInTeam,
  // returning defaultTaskId, needing no separate handling here. SKIP_RE fallback is placed after matching fails
  // to avoid false positives from the virtual entry's "do not associate" text.
  let taskId: string | undefined;
  const taskHay = taskText ?? content;
  taskId = matchTaskInTeam(taskHay, team);
  if (!taskId && SKIP_RE.test(taskHay)) {
    taskId = undefined; // Explicitly typed "skip" → keep undefined (trigger completeRegistration bypass)
  }

  return { agent_id: agentId, task_id: taskId };
}

// ── codex-only Single Question Extractors ─────────────────────────────────────────────────────
//
// 2026-08-08 codex session-init refactor: After splitting pending_agent_task into independent
// pending_agent_select + pending_task_select, each step extracts only one field.
// Reuses the fuzzy matching in matchAgentInTeam / matchTaskInTeam (including label/name/
// suffix/substring fallbacks), ensuring raw labels like "AgentName (xxxxxxxx)" passed down
// from the codex handler are also matched.
//
// The CB client legacy path (asking agent+task together in one shot) continues to use extractFromOptionText,
// leaving these two new functions untouched.

/**
 * Identifies a single agent_id exclusively from a plain text answer (codex single agent_select stage).
 *
 * Returns:
 *   - BYPASS_MARKER: User explicitly expressed "skip/do not associate"
 *   - agent_id: Matched candidate
 *   - null: Unrecognized
 */
export function extractAgentOnly(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string | typeof BYPASS_MARKER | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;
  // opencode: 剥壳 tool-result 包裹（见 extractOpencodeAnswers 头部）。
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (SKIP_RE.test(trimmed) || trimmed.includes(SKIP_LABEL)) return BYPASS_MARKER;
  return matchAgentInTeam(trimmed, team);
}

/**
 * Identifies a single task_id exclusively from a plain text answer (codex single task_select stage).
 *
 * Returns:
 *   - BYPASS_MARKER: User explicitly expressed "skip/do not associate" (Note: "do not associate task" here
 *     hits the defaultTaskId virtual entry in matchTaskInTeam returning a task_id, bypassing the BYPASS branch)
 *   - task_id: Matched candidate
 *   - null: Unrecognized
 */
export function extractTaskOnly(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string | typeof BYPASS_MARKER | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;
  // opencode: 剥壳 tool-result 包裹（见 extractOpencodeAnswers 头部）。
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;
  const trimmed = content.trim();
  if (!trimmed) return null;
  // First attempt to match real/virtual task entries (virtual entry injected by fetchTeamsAndAgents header,
  // matching label "do not associate task this time" returns defaultTaskId, satisfying the "skip task but retain
  // agent" contract, and is not treated as a BYPASS).
  const matched = matchTaskInTeam(trimmed, team);
  if (matched) return matched;
  if (SKIP_RE.test(trimmed) || trimmed.includes(SKIP_LABEL)) return BYPASS_MARKER;
  return null;
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
