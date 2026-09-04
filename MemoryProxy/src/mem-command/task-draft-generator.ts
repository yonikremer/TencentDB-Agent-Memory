/**
 * task-draft-generator · LLM draft generator for mem:create-task / mem:update-task.
 *
 * The proxy's first module that "proactively" initiates a request to the LLM (other LLM calls are passthrough reverse proxies).
 * Skeleton modeled after packages/cost-guard/src/compressor/cfq/llm-infer.ts — directly fetch OpenAI
 * chat/completions + AbortSignal.timeout, without pulling in third-party SDKs.
 *
 * Key differences from CFQ LLMInfer:
 * - CFQ failure = returns null array (silent fallback), because CFQ is an optional enhancement;
 * - This module's failure = returns { ok: false, error } (**explicit error**), because Task is a persistent entity,
 *   a bad draft will pollute the database; the upper command layer will splice the error into the "❌ Task generation failed: ..." message.
 *
 * Used by: mem-command/commands/create-task.ts / update-task.ts (Phases 3.2 / 3.3)
 *
 * Ref: docs/design/... TODO(Phase5) add design docs
 */

/** LLM endpoint configuration. Fields have the same shape as LLMInferConfig for easy future extraction. */
export interface TaskDraftConfig {
  /** Master switch. Default false — when disabled, the command layer directly returns a "not configured" error. */
  enabled: boolean;
  /** Model name, e.g., "deepseek-v3-0324". */
  model: string;
  /** API endpoint (without /chat/completions). */
  url: string;
  /** API Key, passed as Bearer header. */
  apiKey: string;
  /** Single call timeout (milliseconds). Recommended 15000-30000 (drafts need to be complete). */
  timeoutMs: number;
}

/** Recent conversation message snippet (for LLM context understanding). */
export interface DraftMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Current Task (required for update mode). */
export interface CurrentTask {
  title: string;
  description: string;
  status: string;
}

/** Generator input. */
export interface TaskDraftInput {
  /** create: create a new task; update: determine changes based on existing task + rewrite. */
  mode: "create" | "update";
  /** Additional prompt (reason) after user's mem:create-task/update-task, nullable. */
  hint?: string;
  /** Recent conversation messages (cut by proxy from sessionMessages, usually the last 30). */
  recentMessages: DraftMessage[];
  /** Required for update mode, ignored for other modes. */
  currentTask?: CurrentTask;
  /**
   * Only effective in create mode. If the user explicitly specified a title after mem:create-task, proxy forces a lock:
   * The LLM is only responsible for generating a description based on the conversation, and the returned title field is ignored.
   * The caller needs to pass lockedTitle down (generator doesn't truncate to 40 chars, caller guarantees it).
   */
  lockedTitle?: string;
}

/** Generator output: on success carries a structured draft; on failure carries an error message. */
export type TaskDraftResult =
  | {
      ok: true;
      title: string;
      description: string;
      /** Suggested status, allowed to be provided by the model (optional). */
      suggestedStatus?: string;
      /**
       * Only effective in update mode. false means "recent conversation produced no new progress, Task doesn't need update" — the caller
       * should return "Task needs no update" directly to the user, without entering the popup flow. Always true for create mode.
       */
      changed: boolean;
    }
  | { ok: false; error: string };

/**
 * Status validation (relaxed version):
 *   Per TAPD requirements & user decisions, the proxy doesn't do enum validation on status, passes through whatever LLM outputs;
 *   Only does trim + empty/non-string filtering, ultimately decided by the kernel whether to accept.
 */
const MAX_STATUS_LEN = 40;
/** Output schema limit. */
const MAX_TITLE_LEN = 40;
const MAX_DESC_LEN = 300;
/** Recent conversation truncation (prevents prompt from being too long). */
const MAX_RECENT_MSGS = 30;
const MAX_MSG_CONTENT_LEN = 800;
/**
 * Token limit for single LLM generation.
 *
 * Raised from 800 to 2000 (fixed 2026-08-18): actually observed that the total characters of desc + title + status + JSON
 * structure in mixed English/Chinese scenarios often > 800 and got truncated, causing JSON parsing to fail midway.
 * Ref: wiki-ingest uses 8192, L1 extractor uses 4096; here the draft output limit is title≤40
 * + desc≤300 + status, theoretical max ~800 chars → giving 2000 tokens has ample margin.
 */
const LLM_MAX_TOKENS = 2000;

/**
 * LLM call retry strategy (added 2026-08-18).
 *
 * Trigger scenarios: LLM occasional jitter (empty object / truncation / timeout), single success rate is not 100%,
 * but the probability of 2 consecutive empty object/truncations is very low. User perspective: seamless, one click = one success.
 *
 * Parameters:
 *   - LLM_RETRY_MAX_ATTEMPTS=3: Total 3 chances (1 initial + 2 retries)
 *   - LLM_RETRY_BASE_DELAY_MS=200: Exponential backoff base, 2nd try waits 200ms, 3rd try waits 400ms
 *
 * When to retry: As long as attemptDraftOnce returns ok=false, retry (does not distinguish specific error types,
 * because empty object / truncation / schema violation / upstream 5xx are all "it might work if tried again" situations).
 * When not to retry: cfg.enabled=false / parameter validation fails / all 3 attempts fail.
 */
const LLM_RETRY_MAX_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 200;

/**
 * Timeout limit for the first attempt (2026-08-20): observed in production that gateway occasionally hangs for 20-30s,
 * using cfg.timeoutMs (default 30s) on the first try leaves the user hanging. Change the first attempt to min(cfg.timeoutMs,
 * FIRST_TIMEOUT_MS=10s), backoff 200ms + retry immediately upon timeout, retry uses the full timeoutMs
 * to cover "really slow but will succeed" scenarios. Env TDAI_TASK_DRAFT_FIRST_TIMEOUT_MS can override.
 */
const LLM_FIRST_ATTEMPT_TIMEOUT_MS_DEFAULT = 10_000;

function firstAttemptTimeoutMs(configuredTimeoutMs: number): number {
  const raw = process.env.TDAI_TASK_DRAFT_FIRST_TIMEOUT_MS;
  let cap = LLM_FIRST_ATTEMPT_TIMEOUT_MS_DEFAULT;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) cap = n;
  }
  // Cannot exceed the configuration itself (otherwise modifications are invalid)
  return Math.min(configuredTimeoutMs, cap);
}

/**
 * Command keyword stripping table: LLM sometimes literally moves the user's input command into the title (e.g.,
 * "Fix mem:create-task LLM ..."), these prefixes are redundant and eat into the character budget.
 * Strip if matched, so the real semantic part fits within 40 characters.
 */
const COMMAND_KEYWORD_PATTERNS = [
  /^\s*(?:mem:[a-z-]+)\s*[:：、,，]?\s*/i,
  /^\s*(?:fix|refactor|update|create|add|remove)\s+mem:[a-z-]+\s*[:：、,，]?\s*/i,
];

/**
 * create mode system prompt.
 *
 * Strengthened 2026-08-18 (addressing root causes of production failures):
 *   - Used STRICT / MUST NOT / NEVER hard constraint words, instead of previous ≤ 40 (LLM will exceed)
 *   - Added positive and negative examples to clarify to the LLM "what is too long", "what is an empty object"
 *   - Explicitly prohibited empty objects: give a reasonable default even if information is insufficient, avoiding `{}`
 */
const SYSTEM_PROMPT_CREATE = `You are a task drafting assistant for a coding agent's memory system.

Given the recent conversation, generate ONE task that captures what the user is currently working on.

STRICT rules (violations will be rejected):
- title: MUST be 1 to 40 characters. NEVER exceed 40. Imperative form preferred.
- description: MUST be 1 to 300 characters, plain text. Cover three parts in order:
    background → goal → known constraints
- suggestedStatus: short lowercase word (e.g. "running", "completed").
- NEVER return an empty object {}. If the conversation is unclear, infer a reasonable
  task from the most recent user message and produce a best-effort title + description.

Examples of GOOD output:
  {"title":"Refactor auth module","description":"background: existing auth logic is split across 3 files; goal: merge into auth-service; constraint: keep the external API unchanged.","suggestedStatus":"running"}

Examples of BAD output (DO NOT produce these):
  {}                                                     // ❌ empty object
  {"title":"Fix mem:create-task LLM JSON parse failure and add retry logic here"}  // ❌ title too long
  {"title":"Refactor","description":""}                  // ❌ empty description

Return ONLY the JSON object with keys: title, description, suggestedStatus. No prose, no markdown fence.`;

/** create mode (title locked) system prompt —— only lets LLM output description. */
const SYSTEM_PROMPT_CREATE_LOCKED_TITLE = `You are a task drafting assistant for a coding agent's memory system.

The user has ALREADY specified the task title. Your ONLY job is to write a good description
based on the recent conversation that matches this title.

STRICT rules:
- description: MUST be 1 to 300 characters, plain text. Cover three parts:
    background → goal → known constraints
- NEVER return an empty object {}. If unclear, infer a best-effort description from the title
  and most recent messages.
- Do NOT include title in the output (it is fixed by the user).

Return ONLY a JSON object with a single key: description. No prose, no markdown fence.`;

/** update mode system prompt. */
const SYSTEM_PROMPT_UPDATE = `You are a task update assistant for a coding agent's memory system.

Given an existing task and recent conversation, decide:
1. Whether the conversation adds meaningful updates to the task.
2. If yes, produce an updated description and a suggested status.

Classify what changed into ONE OR MORE of these five categories (only if applicable):
  - goal changes
  - constraint changes
  - progress
  - linked resources / references
  - collaborating agents

STRICT rules:
- If NO meaningful update → return {"changed": false}
- If YES → return {"changed": true, "title": ..., "description": ..., "suggestedStatus": ...}
- title: keep the original title unchanged (return it as-is); the caller ignores any change.
- description: MUST be 1 to 300 characters, rewrite/merge current description with categorized new info.
- suggestedStatus: short lowercase word; prefer "completed" if conversation signals done, else "running".
- NEVER return an empty object {}. If truly no update, return {"changed": false} explicitly.

Return ONLY a JSON object. No prose, no markdown fence.`;

/**
 * Constructs the user message to send to the LLM.
 */
function buildUserMessage(input: TaskDraftInput): string {
  const lines: string[] = [];

  if (input.mode === "update" && input.currentTask) {
    lines.push(
      "=== Current Task ===",
      `Title: ${input.currentTask.title}`,
      `Description: ${input.currentTask.description}`,
      `Status: ${input.currentTask.status}`,
      "",
    );
  }

  if (input.mode === "create" && input.lockedTitle) {
    lines.push(
      "=== Task Title (fixed by user, DO NOT change) ===",
      input.lockedTitle,
      "",
    );
  }

  if (input.hint && input.hint.trim().length > 0) {
    lines.push("=== User Hint ===", input.hint.trim(), "");
  }

  lines.push("=== Recent Conversation ===");
  const msgs = input.recentMessages.slice(-MAX_RECENT_MSGS);
  for (const m of msgs) {
    const content = m.content.length > MAX_MSG_CONTENT_LEN
      ? `${m.content.slice(0, MAX_MSG_CONTENT_LEN)}...[truncated]`
      : m.content;
    lines.push(`[${m.role}] ${content}`);
  }

  return lines.join("\n");
}

/**
 * Extracts a JSON object from the LLM's raw output.
 *
 * Three-level fallback:
 *   1) Direct JSON.parse —— covers standard scenarios
 *   2) Strip markdown fence (```json ... ``` or ``` ... ```) then parse
 *   3) Bracket balancing scan: find the first `{`, match up to the corresponding `}` and parse the substring
 *      —— covers scenarios where the LLM surrounds the output with natural language, e.g.:
 *      "Here is the JSON: {...}", "Here you go:\n{...}\nHope this helps"
 *
 * During the scan, `{`, `}`, `"` within string literals are correctly handled (ignored in balancing count).
 *
 * If all three levels fail, returns null (caller will yield "LLM output is not valid JSON" error).
 */
export function extractJsonObject(raw: string): unknown | null {
  // 1) Direct parse
  try {
    return JSON.parse(raw);
  } catch {
    // fall-through
  }

  // 2) Strip markdown fence
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // fall-through
    }
  }

  // 3) Bracket balancing scan
  const balanced = findBalancedJsonObject(raw);
  if (balanced !== null) {
    try {
      return JSON.parse(balanced);
    } catch {
      // fall-through
    }
  }

  return null;
}

/**
 * Bracket balancing scan: finds the first self-contained `{...}` substring in raw.
 * A state machine handles string literals and escapes to prevent `{}` inside strings from messing up the count.
 */
function findBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Normalize string field: trim + length check.
 *
 * mode:
 *   - "strict" (default): returns null if too long (old behavior, for strictly required fields)
 *   - "clip": automatically truncates to maxLen if too long (preserves valid content, for fields like title/description
 *     where "imperfect is better than failing")
 *
 * Empty string always returns null (no truncation can save an empty string).
 */
function normalizeStr(
  v: unknown,
  maxLen: number,
  mode: "strict" | "clip" = "strict",
): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > maxLen) {
    return mode === "clip" ? s.slice(0, maxLen).trim() : null;
  }
  return s;
}

/**
 * Strip command keyword prefixes like mem:xxx from the title.
 * LLM often puts the user's current command literally into the title (e.g., "Fix mem:create-task JSON parse"),
 * stripping it allows the real semantic part to stay within the character limit.
 * Strips only the prefix, not the middle; returns as-is on empty match.
 */
function stripCommandKeywords(s: string): string {
  let out = s;
  for (const pat of COMMAND_KEYWORD_PATTERNS) {
    out = out.replace(pat, "");
  }
  return out.trim();
}

/** Normalize status field: optional, allowed to be missing; no enum validation, basic cleaning only. */
function normalizeStatus(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s.length === 0 || s.length > MAX_STATUS_LEN) return undefined;
  return s;
}

/**
 * Generate Task draft (with automatic retry).
 *
 * Outer layer responsibilities:
 *   - Pre-parameter validation (no retries)
 *   - Loop calling attemptDraftOnce, up to LLM_RETRY_MAX_ATTEMPTS times
 *   - Log on each failure (attempt=N/M reason=xxx), retry after exponential backoff
 *
 * @returns { ok:true, ... } or { ok:false, error }
 */
export async function generateTaskDraft(
  cfg: TaskDraftConfig,
  input: TaskDraftInput,
): Promise<TaskDraftResult> {
  if (!cfg.enabled) {
    return { ok: false, error: "task_draft LLM disabled (config.memCommand.taskDraft.enabled=false)" };
  }
  if (input.mode === "update" && !input.currentTask) {
    return { ok: false, error: "update mode requires currentTask" };
  }
  if (!input.recentMessages || input.recentMessages.length === 0) {
    return { ok: false, error: "no recent messages to draft from" };
  }

  const systemPrompt =
    input.mode === "create"
      ? (input.lockedTitle ? SYSTEM_PROMPT_CREATE_LOCKED_TITLE : SYSTEM_PROMPT_CREATE)
      : SYSTEM_PROMPT_UPDATE;
  const userMessage = buildUserMessage(input);

  let lastError = "unknown";
  for (let attempt = 1; attempt <= LLM_RETRY_MAX_ATTEMPTS; attempt++) {
    const result = await attemptDraftOnce(cfg, input, systemPrompt, userMessage, attempt);
    if (result.ok) {
      if (attempt > 1) {
        // Logging: Let operations know a retry was triggered, but eventually succeeded
        console.log(
          `[task-draft] mode=${input.mode} RETRY_SUCCEEDED attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} prev_error=${JSON.stringify(lastError)}`,
        );
      }
      return result;
    }
    lastError = result.error;
    // Last failure, do not wait
    if (attempt < LLM_RETRY_MAX_ATTEMPTS) {
      const delay = LLM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(
        `[task-draft] mode=${input.mode} RETRY attempt=${attempt}/${LLM_RETRY_MAX_ATTEMPTS} error=${JSON.stringify(result.error)} next_delay_ms=${delay}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.log(
    `[task-draft] mode=${input.mode} ALL_ATTEMPTS_FAILED total=${LLM_RETRY_MAX_ATTEMPTS} last_error=${JSON.stringify(lastError)}`,
  );
  return { ok: false, error: `LLM draft failed after ${LLM_RETRY_MAX_ATTEMPTS} attempts: ${lastError}` };
}

/**
 * Single LLM call + result parsing. **Internal function, do not call directly from outside**.
 *
 * Consistent with the main logic of the old generateTaskDraft, just that:
 *   - Parameter validation is moved to the outer layer
 *   - Added finish_reason / usage / http_status observability logs (even on first success, for tracking jitter rate)
 *
 * The attempt parameter is only used for logging.
 */
async function attemptDraftOnce(
  cfg: TaskDraftConfig,
  input: TaskDraftInput,
  systemPrompt: string,
  userMessage: string,
  attempt: number,
): Promise<TaskDraftResult> {
  let resp: Response;
  // Use short timeout for the first time (default 10s), then use full cfg.timeoutMs
  const effectiveTimeoutMs = attempt === 1 ? firstAttemptTimeoutMs(cfg.timeoutMs) : cfg.timeoutMs;
  try {
    resp = await fetch(`${cfg.url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: LLM_MAX_TOKENS,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(effectiveTimeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `LLM request failed: ${msg}` };
  }

  if (!resp.ok) {
    console.log(
      `[task-draft] mode=${input.mode} attempt=${attempt} FAIL=http_status status=${resp.status}`,
    );
    return { ok: false, error: `LLM upstream ${resp.status}` };
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `LLM response not JSON: ${msg}` };
  }

  // Observe: finish_reason + usage.completion_tokens. Three typical values:
  //   - "stop"          Normal completion
  //   - "length"        Truncated by max_tokens limit → needs max_tokens increase
  //   - "content_filter" Hit safety policy → issue with prompt/context
  //   - null            Upstream gave nothing (mostly empty object scenario)
  const finishReason =
    (payload as { choices?: Array<{ finish_reason?: string | null }> }).choices?.[0]
      ?.finish_reason ?? "unknown";
  const usage = (payload as { usage?: { completion_tokens?: number; total_tokens?: number } })
    .usage;
  const completionTokens = usage?.completion_tokens ?? -1;

  const choices = (payload as { choices?: Array<{ message?: { content?: string } }> }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, error: "LLM response has no choices" };
  }
  const content = choices[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "LLM response content empty" };
  }

  // Observe common fields (every FAIL log will carry these three, for quick root cause spotting)
  const obs = `attempt=${attempt} finish_reason=${finishReason} completion_tokens=${completionTokens}`;

  // Three-level fallback: direct parse → markdown fence → bracket balancing scan
  const parsed = extractJsonObject(content);
  if (parsed === null) {
    // Crucial troubleshooting log: Print the first 500 characters of the LLM's raw content to pinpoint the failure mode
    // (standard scenario / markdown fence / natural language wrapping / no JSON at all)
    // finish_reason=length means max_tokens truncation, limit needs to be increased
    console.log(
      `[task-draft] mode=${input.mode} FAIL=json_parse ${obs} content_preview=${JSON.stringify(previewContent(content))}`,
    );
    return { ok: false, error: "LLM output is not valid JSON" };
  }
  if (typeof parsed !== "object") {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=not_object ${obs} parsed_type=${typeof parsed} content_preview=${JSON.stringify(previewContent(content))}`,
    );
    return { ok: false, error: "LLM output is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  // update mode: look at the changed field first
  if (input.mode === "update" && obj.changed === false) {
    // Keep currentTask values intact and return, upper layer will directly skip popup if changed=false
    return {
      ok: true,
      changed: false,
      title: input.currentTask!.title,
      description: input.currentTask!.description,
      suggestedStatus: input.currentTask!.status,
    };
  }

  // create mode + lockedTitle: force use of lockedTitle, only parse description
  //
  // Forgiveness policy (2026-08-18): description only fails on **complete absence/empty string/non-string**;
  // if too long, automatically truncates to MAX_DESC_LEN——LLM writing a few less words is much better than returning an error to the user.
  if (input.mode === "create" && input.lockedTitle) {
    const description = normalizeStr(obj.description, MAX_DESC_LEN, "clip");
    if (!description) {
      console.log(
        `[task-draft] mode=create-locked FAIL=description ${obs} keys=${JSON.stringify(Object.keys(obj))} desc_type=${typeof obj.description} desc_len=${typeof obj.description === "string" ? obj.description.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
      );
      return { ok: false, error: `description missing or empty` };
    }
    const suggestedStatus = normalizeStatus(obj.suggestedStatus);
    return {
      ok: true,
      changed: true,
      title: input.lockedTitle,
      description,
      ...(suggestedStatus ? { suggestedStatus } : {}),
    };
  }

  // title normalization: first strip command keyword prefixes, then use clip mode.
  //   Typical scenario: "Fix mem:create-task JSON parse failure" (42 chars, would be rejected for exceeding 40)
  //   → Strip "Fix mem:create-task " → "JSON parse failure" (more concise and within character limit)
  const rawTitle = typeof obj.title === "string" ? stripCommandKeywords(obj.title) : obj.title;
  const title = normalizeStr(rawTitle, MAX_TITLE_LEN, "clip");
  if (!title) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=title ${obs} keys=${JSON.stringify(Object.keys(obj))} title_type=${typeof obj.title} title_len=${typeof obj.title === "string" ? obj.title.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
    );
    return { ok: false, error: `title missing or empty` };
  }
  const description = normalizeStr(obj.description, MAX_DESC_LEN, "clip");
  if (!description) {
    console.log(
      `[task-draft] mode=${input.mode} FAIL=description ${obs} keys=${JSON.stringify(Object.keys(obj))} desc_type=${typeof obj.description} desc_len=${typeof obj.description === "string" ? obj.description.length : "n/a"} obj_preview=${JSON.stringify(previewObj(obj))}`,
    );
    return { ok: false, error: `description missing or empty` };
  }
  const suggestedStatus = normalizeStatus(obj.suggestedStatus);

  return {
    ok: true,
    changed: true,
    title,
    description,
    ...(suggestedStatus ? { suggestedStatus } : {}),
  };
}

/**
 * Logging helper: Truncate long strings to prevent the LLM's spam from blowing up the logs.
 * 500 characters is enough to see the JSON structure and main content, the rest is marked with `...[truncated N]`.
 */
function previewContent(s: string): string {
  const MAX = 500;
  return s.length > MAX ? `${s.slice(0, MAX)}...[truncated ${s.length - MAX}]` : s;
}

/**
 * Logging helper: Serialize the parsed obj into a compact string then truncate (retaining structure).
 * Used in failure branches—so that during troubleshooting you can see at a glance what fields and values the LLM actually filled.
 */
function previewObj(obj: Record<string, unknown>): string {
  try {
    return previewContent(JSON.stringify(obj));
  } catch {
    return "[unserializable]";
  }
}
