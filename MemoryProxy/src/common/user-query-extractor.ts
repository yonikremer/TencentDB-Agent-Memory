/**
 * User query extractor —— Strip away all harness context from the user message content of CC / CodeBuddy / other coding agents, retaining only the "text actually typed by the user".
 *
 * Usage scenarios (shared in three places within proxy):
 *   1. tdai/recorder.ts::extractLatestUserMessage —— L0 write
 *   2. agent-adapters/codebuddy.ts::extractUserText —— mem command parser + normalize-conversation extracting clean text for skill buffer
 *   3. mem-command indirectly called via adapter.extractUserText
 *
 * Extraction semantics (ordered by priority):
 *
 *   0) CC client internal prompt / tool_result disguise / session-init receipt,
 *      and DSH plain text `Current runtime context.` snapshot → discard entire message, return "",
 *      caller uses this to decide not to write L0 / not to enter skill buffer for this round
 *
 *   1) Explicit `<user_query>...</user_query>` block (CodeBuddy standard + part of CC templates)
 *      → only extract join inside block, even if the same message contains session-init form concurrently
 *
 *   2) When no user_query, strip sequentially:
 *      - `<question_answer>...</question_answer>` (session-init form backfill)
 *      - Common XML wrappers (system-reminder / additional_data / user_info / open_and_recently_viewed_files / session / persisted-output / tool_use_error / tool_result, etc.)
 *      - Single-line tool echo (Bash completion / cat -n format of Read / Write success receipt)
 *      - MEMORY.md style yaml frontmatter block
 *      - "Session Initialization — ..." remaining title lines
 *      → what's left after stripping is user typing
 *
 * Migration history: This file was extracted from tdai/recorder.ts (originally private to tdai), semantics unchanged.
 * See docs/design/2026-07-30-cc-request-routing-plan.md appendix + codebuddy adapter packet capture conclusion.
 */

/**
 * Title marker for session initialization (select Team / Agent / Task) form Q&A.
 * Used to strip residual title lines; real user input is unaffected.
 */
const SESSION_INIT_TITLE_MARKER = "Session Initialization";

/**
 * Identifier for "internal auxiliary prompts" stuffed into conversation flow with role=user by Claude Code CLI.
 *
 * Scenario: CC client uses role=user to carry various **non-user actual input** content, if the whole message matches any pattern,
 * directly determine as "non-human input" → do not write L0 this round, avoid polluting memory store.
 *
 * Hit rule design:
 *   - **Start** of full message shows clear CC mode markers ([SUGGESTION MODE], [TITLE MODE], etc.);
 *   - Or CC structured metadata JSON ({"parentUuid": ..., "promptId": ...});
 *   - Or system-level recap/summary prompt ("The user stepped away and is coming back...");
 *   - Or receipt of session-init AskUserQuestion ("Your questions have been answered:");
 *   - Or typical format of tool output disguised as user ("(Bash completed with no output)",
 *     `<persisted-output>` large file placeholder, CC timestamp log block).
 *
 * Matching uses startsWith / full string anchor —— do not accidentally hurt real user input.
 */
const CC_INTERNAL_PROMPT_PATTERNS: RegExp[] = [
  // CC mode markers: [XXX MODE: ...] / [XXX: ...]
  /^\s*\[(?:SUGGESTION|TITLE|SUMMARY|COMPACT|COMPACTION|ANALYSIS|EVAL|RECAP|MEMORY|SIDECHAIN)\s+MODE[:\s]/i,
  // CC session resume prompt (defined in core prompts/session-resume)
  /^\s*The user stepped away and is coming back\.\s*Recap/i,
  // AskUserQuestion receipt (session-init or runtime Q&A)
  /^\s*Your questions have been answered:\s*"/i,
  // CC structured promptId metadata JSON (first char is number + JSON or direct JSON meta info)
  /^\s*\d+\s*\{"parentUuid"|^\s*\{"parentUuid":\s*"[^"]+","isSidechain"/,
  // CC replays conversation log with timestamp prefix ([2026-07-11T...][user] / [assistant])
  /^\s*\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\]]*\]\[(?:user|assistant|system)\]/,
  // Note: <persisted-output> / (Bash completed with no output) moved to
  //       wrapper stripping layer of 2b/2c —— they are often concatenated with user's next sentence
  //       in the same user message, should only strip itself, retaining user's subsequent input.
];

function isClaudeCodeInternalPrompt(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return CC_INTERNAL_PROMPT_PATTERNS.some((re) => re.test(t));
}

/**
 * DSH appends runtime environment snapshot as independent `role=user` message after real question.
 * Fixed start, shares same anchor with session-init skip logic, to avoid L0 treating harness metadata as user input.
 * Real user question won't start with this English segment.
 */
export const DSH_RUNTIME_CONTEXT_PREFIX = "Current runtime context.";

export function isDshRuntimeContextSnapshot(text: string): boolean {
  return text.trimStart().startsWith(DSH_RUNTIME_CONTEXT_PREFIX);
}

/**
 * Extract real user typing from original user content text.
 *
 * Returning empty string means "this user message is all harness noise", caller should use this to decide
 * not to write L0 / not to enter skill buffer / not to match mem command.
 *
 * Parameter `raw` must already be a **string** (array content joined by caller themselves —— see extractUserText implementation of each agent-adapter).
 */
export function extractUserQueryText(raw: string): string {
  // 0) CC internal prompt / tool_result disguise / form receipt → discard entirely (do not write L0)
  //    This is highest priority: even if containing <user_query> at the same time, whole message is judged as non-human input.
  //    Real user input won't hit these patterns anchored at start/whole string.
  if (isClaudeCodeInternalPrompt(raw)) return "";
  // DSH runtime-context snapshot: plain text, no XML wrapper, must be discarded entirely,
  // otherwise extractLatestUserMessage scanning from back to front will treat it as real question writing L0.
  if (isDshRuntimeContextSnapshot(raw)) return "";

  // 1) Priority: explicit <user_query> block (even if session-init Q&A is interleaved in the same message,
  //    only take real query, user input kept intact).
  const queries: string[] = [];
  const re = /<user_query>([\s\S]*?)<\/user_query>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const inner = m[1].trim();
    if (inner) queries.push(inner);
  }
  if (queries.length > 0) return queries.join("\n\n");

  // 2) No explicit user_query: strip all "non-user typed" content segments, retaining remaining real user input.
  //    Core principle: only text hand-typed by user is worth writing to L0; all tool echoes
  //    / system reminders / file bodies / form artifacts / CC local memory content —— strip all.
  let text = raw;

  // 2a) session-init form answer <question_answer>...</question_answer>
  text = text.replace(/<question_answer[^>]*>[\s\S]*?<\/question_answer>/gi, "");

  // 2b) XML wrapper class: various harness segments stuffed into user role by CC / CodeBuddy
  //     - system-reminder / system_reminder (cover both spellings)
  //     - additional_data (CB stuffs this in every first segment of user: current_time, etc.)
  //     - user_info (OS/shell/workspace meta info stuffed in CB's first user message)
  //     - open_and_recently_viewed_files
  //     - session (session context wrapper injected by proxy itself)
  //     - persisted-output (CC "Output too large" large file placeholder)
  //     - tool_use_error / tool-use-error / tool-result / tool_result (pseudo wrapper)
  for (const tag of [
    "system-reminder", "system_reminder",
    "additional_data",
    "user_info",
    "open_and_recently_viewed_files",
    "session",
    "persisted-output", "persisted_output",
    "tool_use_error", "tool-use-error",
    "tool_result", "tool-result",
  ]) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
  }

  // 2c) Line-level filtering: single-line matched tool echoes / file segments / memory frontmatter
  //     Each rule judges single line, if matched delete that line; does not block user input on other lines.
  const LINE_DROP_PATTERNS: RegExp[] = [
    // CC Write/Edit tool success receipt
    /^\s*The file .+ has been (updated|created) successfully.*$/i,
    /^\s*File created successfully at:/i,
    // CC Bash tool silent completion
    /^\s*\(Bash completed with no output\)\s*$/,
    // cat -n line number format returned by CC read tool ("     1  content" / "1  content")
    // At least 3 digit number is stricter; 1-2 digits might conflict with user input (e.g., user list "1 abc")
    // Thus here only matches "number + 2 spaces + content" and no other chars at line start —— format unique to cat -n
    /^\s{0,6}\d+\t/,   // cat -n uses tab separator (Read tool's standard format)
    // MEMORY.md related: outputs produced by CC session_init/memory command
    /^\s*File .+ has been (updated|created)/i,
  ];
  text = text
    .split("\n")
    .filter((line) => !LINE_DROP_PATTERNS.some((re) => re.test(line)))
    .join("\n");

  // 2d) Block stripping: MEMORY.md yaml frontmatter (--- to ---, including metadata)
  //     Format:
  //       ---
  //       name: ...
  //       description: ...
  //       metadata: ...
  //       ---
  //     Only matches frontmatter containing at least name / description / metadata / node_type keywords
  //     to avoid accidentally hurting markdown dividers.
  text = text.replace(
    /(?:^|\n)---\s*\n(?:[a-z_][a-z0-9_]*:\s*.*\n)*?(?:name|description|metadata|node_type|originSessionId):[\s\S]*?\n---\s*(?:\n|$)/gi,
    "\n",
  );

  // 2e) Residual session initialization form title lines (e.g., "Session Initialization — Select Agent and Task")
  text = text
    .split("\n")
    .filter((line) => !line.includes(SESSION_INIT_TITLE_MARKER))
    .join("\n");

  // 2f) Collapse redundant blank lines (large blocks of blank lines might be left after preceding stripping)
  text = text.replace(/\n{3,}/g, "\n\n");

  // Remainder is real user input; if the whole message was all CC artifacts originally, it naturally becomes empty here → no L0 write.
  return text.trim();
}
