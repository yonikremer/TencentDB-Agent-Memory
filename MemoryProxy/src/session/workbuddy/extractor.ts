/**
 * WorkBuddy Session Init — Extractor.
 *
 * The WorkBuddy client reuses CC's `AskUserQuestion` tool contract (same tool name
 * and same questions/answers structure, confirmed by the [wb-ask-user-schema]
 * capture). So the tool_result JSON reply shape is **identical** to CC's.
 *
 * This file simply re-exports CC's extractor — preserving the architectural intent
 * that "WB is handled by its own module", while avoiding copy-pasting 400 lines of
 * matching logic. Should either side's behavior diverge later, just add a wrapper
 * here without touching upstream.
 *
 * Note: the `SKIP_LABEL / MORE_LABEL / ASSET_CONFIRM_*` constants in the CC
 * extractor are imported from `./claude-code/form.js`. WB's form.ts defines
 * same-named constants, but their values are identical ("Do not associate this time
 * (skip injection, proceed directly)" / "More →", etc.), so the extractor can use
 * either; reusing CC's is fine.
 */

export {
  BYPASS_MARKER,
  MORE_MARKER,
  extractAssetConfirm,
  extractTeamFromOptionText,
  extractTaskFromOptionText,
  extractFromOptionText,
  extractStructured,
  resolveAgent,
  resolveTask,
} from "../claude-code/extractor.js";
