/**
 * Asset Reflection Injector — for internal evaluation, appends the
 * `<asset_reflection>` block to the end of the system prompt, instructing the agent to evaluate
 * in its final answer "which cloud asset tools were called this turn, and whether they helped".
 *
 * ## Gating
 * Fully aligned with `costGuard.markerOptIn` dual gate mode:
 *   1. `injection.assetReflection.markerOptIn=true` -> factory registers this hook
 *      (otherwise the hook isn't in getAll() on prod pods, zero performance overhead);
 *   2. Request URL contains `/analyse` marker -> execute actually emits the block (otherwise returns [],
 *      zero prompt modification for requests without marker).
 *
 * ## Tag Set
 * Determined by `activeAssetTags` passed in constructor — statically calculated by factory based on
 * which asset injectors are actually registered on this node:
 *   - skill-*         -> `<skill_tools>` + `<available_skills>`
 *   - tdai-*          -> `<tdai_memory_tools>`
 *   - knowledge-*     -> `<knowledge_tools>`
 *
 * None registered (activeAssetTags empty) -> hook never emits.
 */

import type {
  AgentContext,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { hasAnalyseMarker } from "../../routes/whitelist.js";

export interface AssetReflectionInjectorConfig {
  /** List of asset tag names actually enabled on this node (without angle brackets), e.g. `["skill_tools", "tdai_memory_tools"]`. */
  activeAssetTags: string[];
}

const TAG = "[asset-reflection-injector]";

/** Pure function: render the `<asset_reflection>` block. Returns empty string for empty tags to short-circuit. */
export function renderAssetReflectionBlock(tags: string[]): string {
  if (tags.length === 0) return "";
  const tagList = tags.map((t) => `<${t}>`).join(" / ");
  return [
    "<asset_reflection>",
    "**Internal Evaluation Mode** —— The system prompt for this session contains the following cloud asset tool blocks:",
    `  ${tagList}`,
    "",
    "If you **actually called** any of these tools this turn (whether via Bash curl or MCP),",
    "please append a brief review at the **end** of your final answer, formatted exactly as follows:",
    "",
    "[Asset Reflection]",
    "- <tag>::<tool_name>: One sentence stating whether this call **was helpful** (what key info you got / what detours it saved / or why it missed)",
    "- ... (One line per tool called; multiple calls to the same tool can be summarized in one line)",
    "",
    "Rules:",
    "- **Only reflect on tools you actually called this turn**; do not list ones you didn't, don't guess, don't fabricate.",
    "- If you didn't call any of the above cloud asset tools this turn, you must still output:",
    "  [Asset Reflection] No cloud asset tools were used this turn.",
    "- Keep the review brief and honest —— if the tool didn't help, say so directly. This is for integration evaluation, not to solicit positive feedback.",
    "- This section is for internal evaluation only and does not constitute a formal conclusion; please separate clearly from your main answer (e.g. empty line + '---').",
    "</asset_reflection>",
  ].join("\n");
}

/**
 * AssetReflectionInjector —— See file header.
 *
 * point: `system.suffix` (appended to the very end of the system prompt, fits the internal evaluation semantics: read body first, then reflection requirements)
 * priority: `HOOK_PRIORITY.CUSTOM` (1000, runs last, avoids affecting any asset injectors)
 * cacheStrategy: `none` (depends on runtime URL marker, cannot be prewarmed)
 */
export class AssetReflectionInjector implements InjectionHook {
  id = "asset-reflection-injector";
  point = "system.suffix" as const;
  priority: HookPriority = HOOK_PRIORITY.CUSTOM;
  description = "Inject <asset_reflection> block into system prompt when URL has /analyse marker.";
  cacheStrategy: CacheStrategy = "none";

  constructor(private config: AssetReflectionInjectorConfig) {}

  execute(ctx: AgentContext): ContextBlock[] {
    if (this.config.activeAssetTags.length === 0) {
      // Factory guarantees it won't register an injector with empty tags; defensive early return.
      return [];
    }
    const requestPath = ctx.metadata.requestPath ?? "";
    if (!hasAnalyseMarker(requestPath)) {
      // No marker —— zero modification to normal request prompts, ensuring KV cache prefixes are unaffected.
      return [];
    }
    const content = renderAssetReflectionBlock(this.config.activeAssetTags);
    if (!content) return [];
    if (process.env.PROXY_DEBUG_ASSET_REFLECTION) {
      console.log(`${TAG} emit for path=${requestPath} tags=[${this.config.activeAssetTags.join(",")}]`);
    }
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        // cache-strategy=none, but still provide a stable cacheKey for observer deduplication.
        cacheKey: `asset-reflection-injector:${this.config.activeAssetTags.join(",")}`,
      },
    }];
  }
}
