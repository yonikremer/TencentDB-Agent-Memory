/**
 * External asset ID generation (design §4.1.1 / API reference AssetEntity).
 * Metadata module does not generate asset_id; this tool is for caller and test use.
 */
import type { AssetType } from "../types.js";
import { generateRelationId } from "./id-generator.js";

/** `asset_type` → `asset_id` prefix (including part before subsequent `-`). */
export const EXTERNAL_ASSET_ID_PREFIX: Record<AssetType, string> = {
  skill: "skl",
  llm_wiki: "wiki",
  code_graph: "cg",
  chat_memory: "mem",
};

/** Generate standardized external asset ID, e.g. `skl-a3b9c1f2`. */
export function newExternalAssetId(assetType: AssetType): string {
  return `${EXTERNAL_ASSET_ID_PREFIX[assetType]}-${generateRelationId()}`;
}
