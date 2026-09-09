/**
 * Asset deep-link helpers — canonical URL builders + param validators.
 *
 * Scheme (BrowserRouter, back/forward safe):
 *   /wiki /wiki/:wikiId /wiki/:wikiId/:wikiTab(overview|graph|pages|search)
 *   /code /code/:codeId
 *   /skills /skills/:skillId
 *   /memory /memory/:blockId /memory/:blockId/:layer(L0|L1|L2|L3)
 *
 * Pure functions only (no react import) so backend vitest can cover them.
 */

export const WIKI_TABS = ['overview', 'graph', 'pages', 'search'] as const;
export type WikiTab = (typeof WIKI_TABS)[number];

export const MEMORY_LAYERS = ['L0', 'L1', 'L2', 'L3'] as const;
export type MemoryLayerParam = (typeof MEMORY_LAYERS)[number];

export function isWikiTab(v: string | undefined | null): v is WikiTab {
  return v !== undefined && v !== null && (WIKI_TABS as readonly string[]).includes(v);
}

export function isMemoryLayer(v: string | undefined | null): v is MemoryLayerParam {
  return v !== undefined && v !== null && (MEMORY_LAYERS as readonly string[]).includes(v);
}

export function wikiPath(wikiId?: string, tab?: string): string {
  if (!wikiId) return '/wiki';
  return `/wiki/${encodeURIComponent(wikiId)}/${isWikiTab(tab) ? tab : 'overview'}`;
}

export function codePath(codeId?: string): string {
  return codeId ? `/code/${encodeURIComponent(codeId)}` : '/code';
}

export function skillPath(skillId?: string): string {
  return skillId ? `/skills/${encodeURIComponent(skillId)}` : '/skills';
}

export function memoryPath(blockId?: string, layer?: string): string {
  if (!blockId) return '/memory';
  return `/memory/${encodeURIComponent(blockId)}/${isMemoryLayer(layer) ? layer : 'L1'}`;
}

/** Push only when the target differs — re-clicking the same card must not stack duplicate history entries. */
export function navigateIfDiff(navigate: (path: string) => void, path: string): void {
  if (typeof window === 'undefined' || window.location.pathname !== path) navigate(path);
}
