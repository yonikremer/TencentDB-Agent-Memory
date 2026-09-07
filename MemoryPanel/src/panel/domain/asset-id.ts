import type { AssetType } from './entities.js';
import { ulid } from 'ulid';

const PREFIX: Record<AssetType, string> = {
  skill: 'skl',
  llm_wiki: 'wiki',
  code_graph: 'cg',
  chat_memory: 'mem',
};

/** Control side generates external asset_id by asset type (Design §4.1.1). */
export function newExternalAssetId(assetType: AssetType): string {
  return `${PREFIX[assetType]}-${ulid().toLowerCase().slice(-12)}`;
}

/**
 * Org-sync KS mirror routing: kernel asset types that live in KS.
 * Returns the KS grant kind, or null for kernel-only assets (skill/chat-memory).
 */
export function knowledgeKindForAssetType(assetType: string): 'wiki' | 'code-graph' | null {
  if (assetType === 'llm_wiki') return 'wiki';
  if (assetType === 'code_graph') return 'code-graph';
  return null;
}
