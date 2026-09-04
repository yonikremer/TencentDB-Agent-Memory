/**
 * Skill Tools Injector — injects a static `<skill_tools>` block describing
 * cloud-skill operations as curl recipes.
 *
 * Why static: the LLM does NOT see these as native tools (we don't push to
 * `body.tools` — the agent host wouldn't know how to handle them). Instead
 * the LLM uses its existing Bash tool to curl `<proxy_base>/skill-bridge/...`,
 * which the proxy's `/skill-bridge/*` reverse proxy then forwards to core
 * with auth + IdFields injected from the session.
 *
 * The block is rendered once per session (at session_init prewarm) — its
 * content depends only on the proxy base URL, which is stable for the
 * session.
 *
 * Tools injected:
 *   Always (read-only): skill_search, skill_view, skill_files_read,
 *                       skill_extract
 *   Only when allowLlmWrite=true: skill_create, skill_update, skill_patch,
 *                                skill_delete, skill_files_write, skill_files_remove
 *
 * Note: skill_list is intentionally omitted — the <available_skills> block
 * already provides the agent's owned skill catalogue at session init.
 *
 * Sister hook: `skill-injector.ts` produces the dynamic `<available_skills>`
 * block (agent-owned skill listing from /v3/skill/listing).
  *
 * See `docs/design/2026-06-17-team-skill-proxy-runtime.md` §4.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";

export interface SkillToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every `<tool>` recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
  /**
   * Whether to allow the main model to create/modify skills. Default false.
   * When false, only injects read-only tools (search/list/view/files_read).
   * When explicitly true, injects all 10 tools.
   */
  allowLlmWrite?: boolean;
}

/**
 * Render the entire `<skill_tools>` block as a single text string. Pure
 * function for ease of testing.
 */
export function renderSkillToolsBlock(
  proxyBaseUrl: string,
  allowLlmWrite = true,
  sessionId?: string,
  spaceId?: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/skill-bridge/v3/skill`;

  // Gateway needs `x-tdai-service-id: <spaceId>` to pass; `x-conversation-id`
  // lets proxy reuse identity from session (user_id / team_id / agent_id).
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}`;

  const readTools = [
    `  <tool name="skill_search">`,
    `    path: ${bridge}/search`,
    `    body: {"query": "Keywords describing the skill you are looking for (required, >=1 character)"}`,
    `    use:  Search for matching skills by keywords + semantics among skills **you have permission to access in the team** (cross-agent, but **excluding** skills others have set to private —— consistent with the 'Team Assets' tab in frontend). query must be a non-empty string, recommended 2-5 related keywords. When you feel your inherent skills are insufficient, use this to discover other available skills in the team. Return count is fixed by the server; if results are not ideal, try different keywords, do not add top_k/mode or other fields in the body (they will be ignored).`,
    `  </tool>`,
    "",
    // Temporarily offline: the <available_skills> block already injects the agent's inherent skill list, overlapping functionality.
    // Can be restored later if paginated refresh is needed (when too many skills cause truncation).
    // `  <tool name="skill_list">`,
    // `    path: ${bridge}/list`,
    // `    body: {"filters": {"owner_agent_id": "?optional", "name_prefix": "?optional"}, "pagination": {"limit": 50}}`,
    // `    use:  Lists head + active skills; filters by owner / prefix`,
    // `  </tool>`,
    // "",
    `  <tool name="skill_view">`,
    `    path: ${bridge}/get-by-name`,
    `    body: {"skill_name": "<skill name>", "include_content": true, "include_manifest": true}`,
    `    use:  **Open an entry to a skill**: gets the full SKILL.md text + resource directory tree (manifest). If you want to read the bytes of a specific resource file, you must first call this tool to pick a path from the manifest, then use skill_files_read. For skill_name, use the name from \`- name: description\` in <available_skills>, or the name field from skill_search results.`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_read">`,
    `    path: ${bridge}/files/read`,
    `    body: {"skill_id": "skl-xxx", "path": "scripts/run.sh", "encoding": "utf-8|base64"}`,
    `    use:  Read single resource file content. **Must call skill_view first to get the manifest**, pick skill_id + path from it for this tool to locate. Returns a JSON envelope by default (containing base64/utf-8 encoded bytes).\n    To download to local: append -o <local path> to curl, proxy will return raw bytes written directly to the file without entering context. Downloaded scripts require chmod +x before execution.`,
    `  </tool>`,
    "",
    `  <tool name="skill_extract">`,
    `    path: ${bridge}/extract`,
    `    body: {"reason": "?optional, brief reason why the current conversation is worth extracting as a skill (clarity helps the background extractor identify boundaries)"}`,
    `    use:  Immediately archives the current conversation to trigger a skill extraction (async task, background agent analyzes conversation to generate a skill). Proxy uses session identity + conversation buffer accumulated at core side, you do not need to pass messages. Suitable for actively triggering when "user has completed a full workflow worth reusing".`,
    `  </tool>`,
  ];

  const writeTools = [
    `  <tool name="skill_create">`,
    `    path: ${bridge}/create`,
    `    body: {"name": "string", "content": "Full SKILL.md (including frontmatter)", "resources": "?optional array"}`,
    `    use:  Create a new skill; owner automatically = current agent`,
    `  </tool>`,
    "",
    `  <tool name="skill_update">`,
    `    path: ${bridge}/update`,
    `    body: {"skill_id": "skl-xxx", "content": "New SKILL.md"}`,
    `    use:  Replace SKILL.md (version+1)`,
    `  </tool>`,
    "",
    `  <tool name="skill_patch">`,
    `    path: ${bridge}/patch`,
    `    body: {"skill_id": "skl-xxx", "old_string": "...", "new_string": "...", "replace_all": false}`,
    `    use:  SKILL.md substring replacement (avoids large diffs)`,
    `  </tool>`,
    "",
    `  <tool name="skill_delete">`,
    `    path: ${bridge}/delete`,
    `    body: {"skill_id": "skl-xxx"}`,
    `    use:  Soft delete (archived; does not increment version)`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_write">`,
    `    path: ${bridge}/files/write`,
    `    body: {"skill_id": "skl-xxx", "files": [{"path": "scripts/x.sh", "content": "...", "encoding": "utf-8", "is_executable": true}]}`,
    `    use:  Add/modify resource files (version+1)`,
    `  </tool>`,
    "",
    `  <tool name="skill_files_remove">`,
    `    path: ${bridge}/files/remove`,
    `    body: {"skill_id": "skl-xxx", "paths": ["scripts/old.sh"]}`,
    `    use:  Delete resource files (version+1)`,
    `  </tool>`,
  ];

  const note = allowLlmWrite
    ? "Error handling: Response is `{code, message, request_id, data?}` envelope; `code != 0` means business error. Common errors:"
    : "Note: Currently only read-only operations are allowed. Please contact admin if you need to create/modify skills.\nError handling: Response is `{code, message, request_id, data?}` envelope; `code != 0` means business error. Common errors:";

  const readErrors = [
    "- 40001 Parameter validation failed: missing/malformed body fields, check message for specific field name.",
    "- 40101 session not initialized: Session unrecognized (likely using this tool in the wrong conversation environment).",
    "- 40401 SKILL_NOT_FOUND: Skill does not exist or does not belong to your agent; use skill_search first to find similar skills.",
    "- 50301 upstream unavailable: Core temporarily unreachable, try again later.",
  ];
  const writeErrors = [
    "- 40301 SKILL_NOT_OWNER: You are not the owner, cannot modify.",
    "- 40901 SKILL_VERSION_STALE: Version is stale, get latest version with skill_view before writing.",
    "- 42201 SKILL_NAME_DUPLICATE: Name duplicated within team.",
    "- 42202 SKILL_PATCH_NOT_UNIQUE: old_string is not unique, pass replace_all=true.",
  ];

  return [
    "<skill_tools>",
    "Below are the cloud skill operation tools. **These are not local tools**, you need to use Bash to call curl to hit the proxy's skill-bridge path to execute them.",
    "Proxy will automatically inject identity and auth (user_id / team_id / agent_id determined by session), you only need to pass business fields in the body.",
    "",
    "Call template:",
    `  curl -sSk -X POST <bridge>/<action> -H 'content-type: application/json'${authHeader} -d '{...business fields...}'`,
    `  where <bridge> = ${bridge}`,
    "",
    "Available tools:",
    "",
    ...readTools,
    ...(allowLlmWrite ? [""] : []),
    ...(allowLlmWrite ? writeTools : []),
    "",
    note,
    ...readErrors,
    ...(allowLlmWrite ? writeErrors : []),
    "</skill_tools>",
  ].join("\n");
}

/**
 * Skill tools injector.
 *
 * Anchor: lands BEFORE the `skills` slot (CodeBuddy: `<agent_skills>`),
 * priority just before SkillInjector so `<skill_tools>` reads naturally
 * before `<cloud_skills>`.
 */
export class SkillToolsInjector implements InjectionHook {
  id = "skill-tools-injector";
  point = "system.before_tools" as const;
  /** Place ahead of `<available_skills>` (which uses slot=skills, before). */
  anchor: AnchorTarget = { slot: "skills", relation: "before" };
  /** Slightly higher priority than SkillInjector so this block precedes it. */
  priority: HookPriority = HOOK_PRIORITY.SKILL - 1;
  description = "Inject the static <skill_tools> curl-recipe block.";
  /** Block content depends only on proxy base URL — fully session-static. */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private config: SkillToolsInjectorConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { skill?: boolean } | undefined;
    if (caps?.skill === false) return [];
    return this.renderBlocks(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.skill === false) return [];
    return this.renderBlocks(undefined, input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(ctx?: AgentContext, prewarmSessionId?: string, prewarmSpaceId?: string): ContextBlock[] {
    const allowLlmWrite = this.config.allowLlmWrite ?? false;

    let sessionId = prewarmSessionId;
    let spaceId = prewarmSpaceId;
    if (ctx) {
      const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
      const session = custom?.session as Record<string, unknown> | undefined;
      const sid = session?.session_id;
      if (typeof sid === "string" && sid.length > 0) {
        sessionId = sid;
      }
      const sp = session?.space_id;
      if (typeof sp === "string" && sp.length > 0) {
        spaceId = sp;
      }
    }

    const content = renderSkillToolsBlock(this.config.proxyBaseUrl, allowLlmWrite, sessionId, spaceId);
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        // Stable cache-dedup key — varies by allowLlmWrite to avoid stale cache
        cacheKey: `skill-tools-injector:catalog:${allowLlmWrite ? "rw" : "ro"}`,
      },
    }];
  }
}
