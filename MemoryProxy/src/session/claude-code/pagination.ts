/**
 * Claude Code AskUserQuestion pagination layout.
 *
 * Background: CC AskUserQuestion allows up to 4 options per question. Each middle
 * page must keep 1 slot for "More →", so it holds at most 3 real items; the last
 * page has no MORE and can hold 4.
 *
 * Strategy:
 *   - total ≤ 4: show all on a single page (no MORE)
 *   - total > 4: first N-1 pages hold 3 each + MORE, last page holds the rest (∈ [2, 4])
 *
 * Page count: `totalPages = ceil((total - 4) / 3) + 1`
 *   - first N-1 pages hold 3 each = 3(N-1) items
 *   - last page holds total - 3(N-1) items
 *   - solving the other way: total - 3(N-1) ∈ [2, 4] ⇔ N - 1 = ceil((total - 4) / 3)
 *
 * Examples:
 *   total=4  → [4]                      (single page)
 *   total=5  → [3+MORE, 2]
 *   total=6  → [3+MORE, 3]
 *   total=7  → [3+MORE, 4]              ← last page full at 4, one page fewer than "3+2+2"
 *   total=8  → [3+MORE, 3+MORE, 2]
 *   total=9  → [3+MORE, 3+MORE, 3]
 *   total=10 → [3+MORE, 3+MORE, 4]      ← last page full at 4
 *   total=11 → [3+MORE, 3+MORE, 3+MORE, 2]
 *   total=13 → [3+MORE ×3, 4]
 *
 * Every page keeps a constant count ≥ 2 ≤ 4 and is never a solo last page — the
 * autoSelectSolo* fallback branch in init.ts can therefore never reach the MORE
 * paging path (the total===1 case is auto-selected upstream by
 * advanceFromAgentPicked and never reaches the form).
 *
 * agents and tasks share the same pagination with identical behavior.
 */

/** CC AskUserQuestion hard cap per question (includes the MORE slot). */
export const CC_MAX_OPTIONS = 4;

/** Number of real options on non-last pages (keeps 1 slot for MORE→). */
export const CC_PAGE_SIZE = 3;

/** Single-page threshold: when total ≤ this, no paging and no MORE — show all on one page. */
export const CC_SINGLE_PAGE_LIMIT = CC_MAX_OPTIONS;

export interface PageSlice {
  /** Element range [start, end) this page covers; start inclusive, end exclusive — use directly for slicing. */
  start: number;
  end: number;
  /** Whether this page is the last (the last page does not append a MORE option). */
  isLastPage: boolean;
  /** Number of real options shown on this page (= end - start). */
  count: number;
  /** Total page count after paging (1 when total ≤ 4). */
  totalPages: number;
  /** Total element count, so callers can compose the prompt copy. */
  total: number;
}

/**
 * Compute the slice range for `total` items and a target `pageIndex` (0-based).
 *
 * Guarantee: any valid pageIndex returns `count >= 2` (unless total < 2, which is an
 * upstream boundary concern of the form builder, not this function's responsibility).
 *
 * When pageIndex exceeds totalPages-1, clamp it to the last page (defensive; normal
 * callers first compute safeNextPage from totalPages-1, see the MORE branch in init.ts).
 */
export function computePagination(total: number, pageIndex: number): PageSlice {
  const safeTotal = Math.max(0, total);

  // Single-page threshold: no paging when ≤ CC_SINGLE_PAGE_LIMIT.
  if (safeTotal <= CC_SINGLE_PAGE_LIMIT) {
    return {
      start: 0,
      end: safeTotal,
      isLastPage: true,
      count: safeTotal,
      totalPages: 1,
      total: safeTotal,
    };
  }

  // When total > 4: first N-1 pages hold 3 real each + MORE, last page holds total - 3(N-1) items (∈ [2, 4]).
  // N-1 pages carrying 3 each need ≥ (total - 4) items (last page max 4), so N-1 = ceil((total-4) / 3).
  const totalPages = Math.ceil((safeTotal - CC_MAX_OPTIONS) / CC_PAGE_SIZE) + 1;

  // Clamp pageIndex to a valid range (defensive).
  const idx = Math.max(0, Math.min(pageIndex, totalPages - 1));

  const isLastPage = idx === totalPages - 1;
  const start = idx * CC_PAGE_SIZE;
  const end = isLastPage ? safeTotal : start + CC_PAGE_SIZE;

  return {
    start,
    end,
    isLastPage,
    count: end - start,
    totalPages,
    total: safeTotal,
  };
}
