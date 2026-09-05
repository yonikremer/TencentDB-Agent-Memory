/**
 * memory-utils —— Constants, pure utility functions, and types for the Chat Memory page.
 * Extracted from ChatMemoryPanel.tsx.
 */
import { ApiError, type ChatMemoryLayerItem } from '@/lib/teamApi';
import type { MemoryBlock, MemoryLayer } from '../constants/types';

export const LAYER_PAGE_SIZE: Record<MemoryLayer, number> = { L0: 20, L1: 20, L2: 50, L3: 50 };
export function layerPageSize(layer: MemoryLayer): number {
  return LAYER_PAGE_SIZE[layer];
}

/** Detail page time filter range, start / end are ISO8601 strings */
export interface TimeRange {
  start: string;
  end: string;
}

/** Detail page time filter default range: current time ~ previous day */
export function defaultTimeRange(): TimeRange {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Business error returned when the backend detects that "the filter range is too large for VDB to support" */
export function isRangeTooLargeError(e: unknown): boolean {
  return e instanceof ApiError && e.message === 'RANGE_TOO_LARGE';
}

export function mapLayerItem(i: ChatMemoryLayerItem) {
  return {
    id: i.id,
    title: i.title,
    body: i.body,
    refs: i.refs,
    tags: i.tags,
    created_at: i.created_at,
  };
}

/**
 * Strip the META header from the scenario (L2) markdown.
 * The body returned by scenario/read contains `-----META-START-----...-----META-END-----`
 * System field headers; the editor only displays the plain body, and the backend will automatically rebuild it using the existing META when writing back.
 */
export function stripScenarioMeta(content: string): string {
  return content
    .replace(/^-----META-START-----\n[\s\S]*?\n-----META-END-----\n?/, '')
    .replace(/^\n+/, '');
}

// Construct the initial layerCounts from the list interface's layer_counts: only keep real counts greater than 0,
// leaving the rest as undefined = "unknown". Badges use this to display placeholders, avoiding displaying "not loaded" as "0",
// and also avoiding pre-requesting for counts. This will automatically adopt the values directly once the backend's layer_counts is implemented.
export function buildInitialLayerCounts(lc: {
  L0_messages: number;
  L1: number;
  L2: number;
  L3: number;
}): MemoryBlock['layerCounts'] {
  const out: MemoryBlock['layerCounts'] = {};
  if (lc.L0_messages > 0) out.L0 = lc.L0_messages;
  if (lc.L1 > 0) out.L1 = lc.L1;
  if (lc.L2 > 0) out.L2 = lc.L2;
  if (lc.L3 > 0) out.L3 = lc.L3;
  return out;
}

/**
 * Copy text to clipboard and return whether it was successful.
 *
 * navigator.clipboard is only available in a secure context (HTTPS / localhost); if the panel is via
 * http:// + intranet IP access, navigator.clipboard is undefined, which will cause copy to fail.
 Therefore, prefer the Clipboard API, and fall back to document.execCommand('copy') when it is unavailable
 * The temporary textarea solution, compatible with non-secure contexts.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Preferred: Clipboard API in a secure context
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Falls back to the execCommand below
    }
  }
  // Fallback: use execCommand for non-secure context (http + IP)
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Move out of viewport, avoid scroll and focus jumping
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
