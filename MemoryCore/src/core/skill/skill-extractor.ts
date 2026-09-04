/**
 * SkillExtractor — Extraction entry point accepting structured ExtractMessage[]
 *
 * Differences from old SkillExtractor:
 *   - Input messages must be `ExtractMessage[]`, no longer accepts bare strings
 *   - Internally serializes messages into transcript (preserving role markers)
 *   - Tool calls route through SkillToolsV2 (operating SkillCore)
 *   - Candidate returns in ExtractedSkillCandidate shape (includes skill_id / version)
 *
 * Every call goes to LLM, zero conversation-level deduplication/caching — caching mechanism removed.
 */

import type { ExtractMessage } from "./types.js";
import type { SkillCore } from "./skill-core.js";
import { createSkillTools, type ExtractedSkillCandidate } from "./skill-tools.js";
import type {
  ISkillExtractor,
  ConversationMessage,
  ExtractedCandidate,
} from "./queue/types.js";
import { metricProducer } from "../report/kafka-metric-producer.js";
import { trace } from "../report/trace.js";
import { obsLogger } from "../report/obs-logger.js";

const TAG = "[skill-extractor]";

export interface ExtractorRunner {
  run(params: {
    prompt: string;
    systemPrompt?: string;
    tools?: Record<string, unknown>;
    enableTools?: boolean;
    maxIterations?: number;
    /** Output token limit; if omitted, handled by runner fallback (standard runner uses llm.maxTokens). */
    maxTokens?: number;
    taskId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Langfuse trace name (used for UI filtering and naming, see core/types.ts LLMRunParams). */
    traceName?: string;
    /** Langfuse tags (used for UI filtering). */
    tags?: string[];
    /** Langfuse top-level sessionId. */
    sessionId?: string;
    /** Langfuse top-level userId. */
    userId?: string;
    /** Instance id; passed through as telemetry instanceId (when missing, runner falls back to "unknown"). */
    instanceId?: string;
  }): Promise<string>;
}

export interface ExtractorOptions {
  core: SkillCore;
  runner?: ExtractorRunner;
  systemPrompt?: string;
  maxIterations?: number;
  /** Transcript head-tail truncation: chars to keep from the start (default 8000). */
  headChars?: number;
  /** Transcript head-tail truncation: chars to keep from the end (default 32000). */
  tailChars?: number;
  /**
   * Skill review single LLM call output token limit. If omitted → runner inherits llm.maxTokens.
   * Configured independently of llm.maxTokens: skill review output (including full SKILL.md
   * inside tool-call params) is typically larger than other stages, may need individual bumping.
   */
  maxTokens?: number;
  /**
   * Prefetch skill list item limit (shared by relevant BM25 search & recent fallback).
   * Constructor defaults to 0 (disabled); production wiring layer (tdai-core / server) explicitly
   * passes resolved.extraction.prefixSkillsLimit from skill-config (default 20). When instantiated
   * without params in tests, triggers no extra query-gen LLM calls.
   */
  prefixSkillsLimit?: number;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export interface ExtractInput {
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id?: string;
  session_id?: string;
  /** Instance id (= space_id); passed through as runner telemetry instanceId. */
  space_id?: string;
  messages: ExtractMessage[];
  options?: {
    max_iterations?: number;
  };
  /** Main Agent's extraction hint, injected to the very top of extraction LLM user prompt when present. */
  reason?: string;
}

export interface ExtractResult {
  candidates: ExtractedSkillCandidate[];
  text?: string;
}

export class SkillExtractor {
  private readonly core: SkillCore;
  private readonly runner?: ExtractorRunner;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;
  private readonly headChars: number;
  private readonly tailChars: number;
  private readonly maxTokens?: number;
  private readonly prefixSkillsLimit: number;
  private readonly logger?: ExtractorOptions["logger"];

  constructor(opts: ExtractorOptions) {
    this.core = opts.core;
    this.runner = opts.runner;
    this.systemPrompt = opts.systemPrompt ?? "You are a Skill Review Agent. Use tools to look at existing skills, decide what to add/improve, and call skill_create / skill_update / skill_patch / skill_files_write to persist.";
    this.maxIterations = opts.maxIterations ?? 16;
    this.headChars = opts.headChars ?? 8000;
    this.tailChars = opts.tailChars ?? 32000;
    this.maxTokens = opts.maxTokens;
    // Constructor defaults to 0 (prefix injection disabled → won't trigger extra query-gen LLM calls);
    // Production wiring explicitly passes resolved.extraction.prefixSkillsLimit (default 20).
    // <0 or NaN falls back to 0 (equivalent to disabled), instead of silently clamping to 20 —
    // we don't want a misconfiguration to silently incur "an unexpected extra LLM call".
    const rawLimit = opts.prefixSkillsLimit;
    this.prefixSkillsLimit = rawLimit === undefined
      ? 0
      : (Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.floor(rawLimit) : 0);
    this.logger = opts.logger;
  }

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const { messages } = input;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("ExtractV2: messages must be a non-empty array of ExtractMessage");
    }
    // [obs] Summarize one extraction event per call; LLM internal iterations trace via langfuse (trace.report
    // → OTel Span → Langfuse SpanProcessor filters and uploads), here we only summarize "entry → exit"
    // duration / candidate count, anchoring with task_id to align with worker segment. obsLogger
    // internals try/catch + FileLogger + backend degradation, if logger crashes extraction proceeds unaffected.
    const t0 = Date.now();
    const transcript = formatTranscript(messages);

    const truncated = truncateHeadTail(transcript, this.headChars, this.tailChars);

    // Prefetch skill list, inject before user prompt, allowing review agent to see right upon entry
    // what skills the agent already owns (prevents blind skill_create hitting SKILL_NAME_DUPLICATE).
    //
    // Three modes, jointly decided by prefixSkillsLimit + total skills owned by agent:
    //   full     — total ≤ limit: Inject all; zero query-gen LLM cost.
    //   relevant — total > limit + query-gen success + BM25 hits ≥1: Relevance priority.
    //   recent   — total > limit + relevant failed (query-gen threw / empty / 0 hits):
    //              Fallback to top-N ordered by updated_at DESC + "X more not shown" hint.
    //   none     — prefixSkillsLimit=0 or total=0.
    //
    // Crucially: A single core.list({ limit }) fetches items + total simultaneously, reused by all branches thereafter,
    // avoiding a second DB query; total ≤ limit scenarios skip query-gen entirely, achieving higher coverage.
    let prefixBlock = "";
    let prefixMode: "full" | "relevant" | "recent" | "none" = "none";
    let prefixQuery: string | undefined;
    if (this.prefixSkillsLimit > 0) {
      let recentPage: Awaited<ReturnType<typeof this.core.list>> | null = null;
      try {
        recentPage = await this.core.list({
          user_id: input.user_id,
          team_id: input.team_id,
          agent_id: input.agent_id,
          pagination: { limit: this.prefixSkillsLimit },
        });
      } catch (e) {
        // list crashed → subsequent branches have no data either, fall directly into none branch.
        this.logger?.warn(`${TAG} prefix list failed: ${(e as Error).message}`);
      }
      if (recentPage && recentPage.items.length > 0) {
        if (recentPage.total <= this.prefixSkillsLimit) {
          // Case full: Got them all, lay them out directly; query-gen completely avoided.
          prefixBlock = renderFullSkillsBlock(recentPage.items);
          prefixMode = "full";
        } else {
          // Case relevant: total exceeds limit, spend one LLM query-gen + BM25 to find most relevant.
          try {
            const relevant = await this.buildRelevantSkillsBlock(input, truncated);
            if (relevant) {
              prefixBlock = relevant.block;
              prefixMode = "relevant";
              prefixQuery = relevant.query;
            }
          } catch (e) {
            this.logger?.warn(`${TAG} buildRelevantSkillsBlock failed: ${(e as Error).message}`);
          }
          if (!prefixBlock) {
            // Case recent: relevant failed, fallback to the top-N fetched initially, appended
            // with "X more not shown" hint so LLM knows it can manually pull more via skill_list.
            prefixBlock = renderRecentSkillsBlock(recentPage.items, recentPage.total);
            prefixMode = "recent";
          }
        }
      }
    }
    let prompt = prefixBlock ? `${prefixBlock}\n\n---\n\n${truncated}` : truncated;

    // Inject Main Agent's extraction hint (when reason is non-empty, placed at the very top of prompt)
    if (input.reason && input.reason.trim().length > 0) {
      const hintBlock = [
        "## Main Agent's Extraction Hint",
        "Below is the main agent's instruction for this conversation, please prioritize its intent during extraction:",
        input.reason,
      ].join("\n");
      prompt = `${hintBlock}\n\n---\n\n${prompt}`;
    }

    const auditSink: ExtractedSkillCandidate[] = [];

    if (!this.runner) {
      // No runner injected (test environment / disabled) → Return empty candidates
      this.logger?.info(`${TAG} no runner provided; returning empty candidates`);
      obsLogger.info("skill.extractor.extract", {
        task_id: input.task_id,
        dur_ms: Date.now() - t0,
        msg_count: messages.length,
        candidates: 0,
        skipped: "no_runner",
      });
      return { candidates: [] };
    }

    const tools = createSkillTools({
      core: this.core,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      auditSink,
      logger: this.logger,
    });

    let text: string;
    try {
      text = await this.runner.run({
        prompt,
        systemPrompt: this.systemPrompt,
        tools,
        enableTools: true,
        maxIterations: input.options?.max_iterations ?? this.maxIterations,
        maxTokens: this.maxTokens,
        taskId: `skill-extract-${input.task_id ?? "unknown"}`,
        // Langfuse trace semantics: Gives this extraction a stable name / filterable tags in Langfuse UI.
        // See detailed comments on traceName/tags/sessionId/userId in core/types.ts LLMRunParams.
        traceName: "skill.extract",
        tags: [
          "skill-extract",
          `team:${input.team_id}`,
          `agent:${input.agent_id}`,
        ],
        sessionId: input.session_id,
        userId: input.user_id,
        instanceId: input.space_id,
      });
    } catch (e) {
      // A single warn summarizes the failure, includes task_id / err_name / dur — Worker side classifies
      // (transient / permanent) to decide requeue or DLQ. Do not swallow the exception here.
      const dur = Date.now() - t0;
      obsLogger.warn("skill.extractor.extract", {
        task_id: input.task_id,
        dur_ms: dur,
        msg_count: messages.length,
        candidates: auditSink.length,
        err_name: (e as Error).name,
        err_msg: (e as Error).message,
      });
      try {
        trace.report("skill.extractor.extract", {
          task_id: input.task_id,
          team_id: input.team_id,
          agent_id: input.agent_id,
          session_id: input.session_id,
          msg_count: messages.length,
          candidates: auditSink.length,
          dur_ms: dur,
          success: false,
          error: (e as Error).message,
        });
      } catch { /* noop */ }
      throw e;
    }

    try { metricProducer.send({ metric: "skill.extract.candidates", instanceId: input.team_id, value: auditSink.length }); } catch { /* noop */ }

    const dur = Date.now() - t0;
    obsLogger.info("skill.extractor.extract", {
      task_id: input.task_id,
      dur_ms: dur,
      msg_count: messages.length,
      candidates: auditSink.length,
      prompt_chars: prompt.length,
      prefix_mode: prefixMode,
      // Only slice first 60 chars (enough for keyword ID; longer is useless for obs).
      prefix_query: prefixQuery ? prefixQuery.slice(0, 60) : undefined,
    });
    try {
      trace.report("skill.extractor.extract", {
        task_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: input.session_id,
        msg_count: messages.length,
        candidates: auditSink.length,
        prompt_chars: prompt.length,
        dur_ms: dur,
        success: true,
      });
    } catch { /* noop */ }

    return { candidates: auditSink, text };
  }

  /**
   * "Possibly relevant to this conversation" skill prefetching: Uses runner for one lightweight LLM call
   * to squeeze 2-5 BM25 keywords from transcript, then calls core.search to get top-N (capped by
   * prefixSkillsLimit). Success + non-empty → returns { block, query }; empty query
   * / empty search hits / missing runner all return null, letting upstream fallback to recent mode.
   *
   * Split into two steps (instead of merging relevant search into the review agent's iteration) because:
   *   1. Review agent enters with a concrete candidate pool, rather than flying blind initially;
   *   2. query-gen is a short output (≤100 tokens), doesn't consume review agent context window;
   *   3. Fails gracefully; running skill_list inside review agent degrades to "all owned",
   *      whereas this function can selectively degrade to relevant or recent.
   */
  private async buildRelevantSkillsBlock(
    input: ExtractInput,
    transcript: string,
  ): Promise<{ block: string; query: string } | null> {
    if (!this.runner) return null;

    const query = await this.generateSearchQueryFromTranscript(input, transcript);
    if (!query) return null;

    let hits: Awaited<ReturnType<typeof this.core.search>>;
    try {
      hits = await this.core.search({
        user_id: input.user_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        query,
        top_k: this.prefixSkillsLimit,
      });
    } catch (e) {
      this.logger?.warn(`${TAG} relevant search failed for query='${query}': ${(e as Error).message}`);
      return null;
    }
    if (!hits.length) return null;

    const lines = hits.map((h) => formatSkillLine(h.skill.name, h.skill.description));
    const block = [
      `## Skills possibly relevant to this conversation (query='${query}', BM25 prefetched)`,
      "These were retrieved by pre-running skill_list(query=...) against your own skill pool.",
      "If any of these already covers the topic, prefer `skill_update` / `skill_patch` over creating a duplicate.",
      ...lines,
    ].join("\n");
    return { block, query };
  }

  /**
   * Runs one tool-less short LLM call to extract 2-5 BM25 keywords from transcript.
   * Return value is sanitized (newlines / FTS5 reserved words replaced by spaces, empty string treated as failure).
   * Exceptions thrown by runner are re-thrown, upstream (buildRelevantSkillsBlock) will catch and degrade.
   */
  private async generateSearchQueryFromTranscript(
    input: ExtractInput,
    transcript: string,
  ): Promise<string> {
    if (!this.runner) return "";
    const raw = await this.runner.run({
      systemPrompt: QUERY_GEN_SYSTEM_PROMPT,
      prompt: [
        "Below is a past conversation. Extract 2-5 short keywords (Chinese or English) that",
        "capture what the user was trying to do. These will feed a BM25 search over an",
        "existing skill library. Output the keywords on a single line, space-separated,",
        "no punctuation, no labels, no explanation.",
        "",
        "<<transcript>>",
        transcript,
        "<<end-of-transcript>>",
      ].join("\n"),
      enableTools: false,
      // Tell runner not to run the tool loop, treat as a single simple completion.
      maxIterations: 1,
      // Keywords are short; 32 tokens easily handles 5 words ×~6 char CJK, helping runner return fast.
      maxTokens: 64,
      taskId: `skill-extract-query-${input.task_id ?? "unknown"}`,
      // Allows separating these query-gen calls in Langfuse via this traceName, isolated from main skill.extract.
      traceName: "skill.extract.query-gen",
      tags: [
        "skill-extract",
        "skill-extract-query-gen",
        `team:${input.team_id}`,
        `agent:${input.agent_id}`,
      ],
      sessionId: input.session_id,
      userId: input.user_id,
      instanceId: input.space_id,
    });
    return sanitizeGeneratedQuery(raw);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  helpers
// ═════════════════════════════════════════════════════════════════════

/**
 * Serializes ExtractMessage[] into a transcript for the Skill Review Agent.
 *
 * Critical design (aligning with "Role isolation" section in SKILL_REVIEW_PROMPT):
 *   - role prefixes use unnatural `<<past-xxx>>` double angle bracket tags, instead of `[user]` / `[assistant]`.
 *     The latter are native role signals for chat completion, models instinctively treat a trailing
 *     `[assistant]` as an anchor to "continue generating the next turn", directly appending the main agent's reply.
 *     Atypical tags like `<<past-user>>` break this implication, explicitly telling the model "this is the historical
 *     content I am reviewing, not the role I am playing".
 *   - Appends an `<<end-of-transcript>>` anchor at the very end + a sentence "Now decide, and respond only per the
 *     output contract in the system prompt." Without this anchor, a model seeing the transcript abruptly end on a
 *     long assistant reply will easily drift into "continuing the reply in a similar tone".
 *
 * Background: docs/2026-07-28 skill extractor role-capture analysis (trace
 * f546ab8c-c7c5-4598-a310-6b2162372e7c, extraction LLM completely ignored SKILL_REVIEW_PROMPT
 * contract, yielded 1235 tokens of main dialogue continuation, zero tool calls, zero "Nothing to save.").
 */
function formatTranscript(messages: ExtractMessage[]): string {
  const body = messages.map((m) => `<<past-${m.role}>>\n${m.content}`).join("\n\n");
  return `${body}\n\n<<end-of-transcript>>\nAbove is the past conversation to review. Now decide, and respond only per the output contract in the system prompt.`;
}

function truncateHeadTail(s: string, head: number, tail: number): string {
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}\n\n... [truncated ${s.length - head - tail} chars] ...\n\n${s.slice(-tail)}`;
}

/**
 * System prompt for "squeezing 2-5 BM25 keywords from conversation".
 * Key points:
 *   1. Explicitly states these keywords feed into BM25 → biases LLM towards high-signal words, not full sentences;
 *   2. Chinese and English both fine, jieba tokenizes them correctly;
 *   3. Single line output + no punctuation + no labels; post-processing sanitize enforces this shape.
 */
const QUERY_GEN_SYSTEM_PROMPT = [
  "You are helping build a BM25 keyword query.",
  "Given a past user↔assistant conversation, output 2-5 short high-signal keywords",
  "(Chinese or English mixed as they appear in the transcript) that best represent",
  "what the user was trying to accomplish.",
  "",
  "Rules:",
  "- Output ONLY the keywords, on a single line, separated by single spaces.",
  "- No punctuation, no quotes, no bullets, no labels, no explanation.",
  "- Do NOT invent topics not present in the transcript.",
  "- Prefer nouns / product names / verbs; drop filler words (the, a, 一下, 帮我).",
  "- If the transcript is empty or has no clear intent, output an empty line.",
].join("\n");

/**
 * Generated query sanitization:
 *   - Take only the first line (LLM sometimes prepends "Here are the keywords:" before the line)
 *   - Strip FTS5 reserved words (AND/OR/NOT/NEAR) completely (BM25 layer builds fallback via buildFtsQuery)
 *   - Strip common punctuation (punctuation causes jitter in BM25 tokenizer)
 *   - Collapse whitespace, trim
 *   - Conservative length limit: max 120 chars (5 words × ~24 chars)
 * Outputs empty string = considered a miss by LLM; upstream falls back to recent.
 */
function sanitizeGeneratedQuery(raw: string): string {
  if (typeof raw !== "string") return "";
  // Take only first non-empty line —— LLM occasionally wraps keywords with a line of metadata.
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!firstLine) return "";
  // Strip common punctuation / FTS5 reserved words. Replace with spaces instead of deleting to prevent "foo,bar" becoming "foobar".
  const noPunct = firstLine
    .replace(/[,;:!?"'`()\[\]{}<>|/\\*+=~@#$%^&]/g, " ")
    .replace(/[，。；：！？、（）【】《》「」『』]/g, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ");
  const collapsed = noPunct.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > 120 ? collapsed.slice(0, 120).trimEnd() : collapsed;
}

/**
 * Formats a single line "- name — description truncated to 100 char". Empty description falls back to "- name".
 * Shared by recent / relevant / full blocks, preventing line format drift.
 */
function formatSkillLine(name: string, description?: string): string {
  const desc = (description ?? "").trim().replace(/\s+/g, " ");
  const short = desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
  return short ? `- ${name} — ${short}` : `- ${name}`;
}

/**
 * "Full" prefix block —— total skills for this agent ≤ prefixSkillsLimit, renders completely.
 * Semantically tells the LLM "this is all your skills, none omitted", providing a stronger prior than recent block.
 * No truncation hints during reuse (because none were truncated).
 */
function renderFullSkillsBlock(items: Array<{ name: string; description?: string }>): string {
  const lines = items.map((s) => formatSkillLine(s.name, s.description));
  return [
    `## Skills you (this agent) own (${items.length} total — full list, no truncation)`,
    "This is your entire skill inventory. Consider `skill_update` / `skill_patch` on an existing skill before creating a new one.",
    ...lines,
  ].join("\n");
}

/**
 * "Recently updated" prefix block —— fallback when relevant branch fails. Includes "X more not shown"
 * hint, letting the LLM know it can proactively call skill_list(query=...) to pull more.
 */
function renderRecentSkillsBlock(
  items: Array<{ name: string; description?: string }>,
  total: number,
): string {
  const lines = items.map((s) => formatSkillLine(s.name, s.description));
  const omitted = total - items.length;
  const header = `## Skills you (this agent) own (${items.length} most-recently-updated of ${total} total, prefetched via skill_list)`;
  const hint = omitted > 0
    ? `Most recent first. ${omitted} more not shown — call skill_list(query=...) to search the rest. Consider \`skill_update\` / \`skill_patch\` on an existing skill before creating a new one.`
    : "Most recent first. Consider `skill_update` / `skill_patch` on an existing skill before creating a new one.";
  return [header, hint, ...lines].join("\n");
}

// ═════════════════════════════════════════════════════════════════════
//  ISkillExtractor adapter — Allows SkillConversationExtractWorker (agent queue)
//  to drive the V2 extractor. ISkillExtractor held by Worker expects
//  conversation: ConversationMessage[] + agent_id; here we map it into V2's
//  ExtractMessage[] format.
// ═════════════════════════════════════════════════════════════════════

const ALLOWED_ROLES = new Set(["user", "assistant", "tool_call", "tool_result"]);

function toExtractMessages(conv: ConversationMessage[]): ExtractMessage[] {
  return conv.map((m) => ({
    role: (ALLOWED_ROLES.has(m.role) ? m.role : "user") as ExtractMessage["role"],
    content: m.content,
  }));
}

function toLegacyCandidates(items: ExtractedSkillCandidate[]): ExtractedCandidate[] {
  return items.map((c) => ({
    action: c.action as ExtractedCandidate["action"],
    name: c.name,
    skill_id: c.skill_id,
    version: c.version,
    description: c.description,
    confidence: c.confidence,
    reason: c.reason,
    file_path: c.file_path,
    file_type: c.file_type,
  }));
}

/**
 * Wraps SkillExtractor into ISkillExtractor, easily driven directly by
 * SkillConversationExtractWorker (agent queue).
 *
 * Input input.agent_id must be provided by the caller (during trigger.archive), sourced from
 * SkillTaskEntry.agent_id. When missing, returns empty candidates and prints a warn log — extraction
 * relies on owner validation, cannot be persisted without agent_id.
 */
export function createExtractorAdapter(
  v2: SkillExtractor,
  logger?: { warn(msg: string): void },
): ISkillExtractor {
  return {
    async extract(input) {
      const agentId = (input as { agent_id?: string }).agent_id;
      if (!agentId) {
        logger?.warn(
          `${TAG} V2 adapter: input.agent_id missing — skipping extract (returns empty candidates)`,
        );
        return { candidates: [] };
      }
      const r = await v2.extract({
        user_id: input.user_id ?? "",
        team_id: input.team_id,
        agent_id: agentId,
        task_id: input.task_id ?? input.taskId,
        // Langfuse trace binding fields: Read by Worker from SkillTaskEntry and passed through,
        // omission results in trace sessionId=null / instanceId=unknown (invisible to session filters).
        session_id: input.session_id,
        space_id: input.space_id,
        messages: toExtractMessages(input.conversation),
        reason: (input as { reason?: string }).reason,
        options: (input as { options?: { max_iterations?: number } }).options,
      });
      return { candidates: toLegacyCandidates(r.candidates) };
    },
  };
}
