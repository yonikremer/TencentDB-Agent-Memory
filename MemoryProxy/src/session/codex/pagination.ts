/**
 * Codex `request_user_input` pagination layouter —— structure copied from
 * `session/claude-code/pagination.ts`; the only difference is codex's option cap
 * vs CC's:
 *
 * - codex allows at most **3** options per question (the client auto-appends
 *   "Other" taking 1 slot; we cannot add one ourselves, so 2 or 3 slots are usable)
 * - middle pages must keep 1 slot for "MORE →" paging → each page holds at most 2 real
 * - last page has no MORE → can fill up to 3
 *
 * Strategy:
 *   - total ≤ 3: single page shows all (no MORE)
 *   - total > 3: first N-1 pages each hold 2 real + MORE; last page takes the
 *     rest (∈ [2, 3])
 *
 * Page count: `totalPages = ceil((total - 3) / 2) + 1`
 *   - first N-1 pages each hold 2 real = 2(N-1) items
 *   - last page holds total - 2(N-1) items
 *
 * Effect:
 *   total=3  → [3]                   (single page)
 *   total=4  → [2+MORE, 2]
 *   total=5  → [2+MORE, 3]           ← last page fills to 3, avoids solo vs "2+2+1"
 *   total=6  → [2+MORE, 2+MORE, 2]
 *   total=7  → [2+MORE, 2+MORE, 3]
 *   total=8  → [2+MORE, 2+MORE, 2+MORE, 2]
 *
 * Every page's count stays ≥ 2 ≤ 3; the last page is never solo.
 *
 * Shares the same philosophy as CC pagination, only the constants differ
 * (3/2 vs 4/3). agents and tasks both use this.
 */

/** codex `request_user_input` hard option cap per question (the client's "Other" slot is separate). */
export const CODEX_MAX_OPTIONS = 3;

/** Real options per non-last page (keeps 1 slot for MORE→). */
export const CODEX_PAGE_SIZE = 2;

/** Single-page threshold: no paging and no MORE when total ≤ this value. */
export const CODEX_SINGLE_PAGE_LIMIT = CODEX_MAX_OPTIONS;

export interface CodexPageSlice {
  /** Element range this page covers: [start, end). */
  start: number;
  end: number;
  /** Whether this page is the last (the last page gets no MORE option appended). */
  isLastPage: boolean;
  /** Number of real options this page shows (= end - start). */
  count: number;
  /** Total pages after pagination (1 when total ≤ 3). */
  totalPages: number;
  /** Total element count, handy for callers assembling prompt text. */
  total: number;
}

/**
 * Computes the slice range for a target `pageIndex` (0-based) out of `total` items.
 *
 * Guarantees: any valid pageIndex returns `count >= 2` (unless total < 2 —— a
 * boundary case covered by the upstream form builder).
 *
 * pageIndex beyond totalPages-1 is clamped to the last page (defensive; normal
 * callers compute safeNextPage from totalPages-1 first).
 */
export function computeCodexPagination(
  total: number,
  pageIndex: number,
): CodexPageSlice {
  const safeTotal = Math.max(0, total);

  if (safeTotal <= CODEX_SINGLE_PAGE_LIMIT) {
    return {
      start: 0,
      end: safeTotal,
      isLastPage: true,
      count: safeTotal,
      totalPages: 1,
      total: safeTotal,
    };
  }

  // When total > 3: first N-1 pages each hold 2 real + MORE; last page takes total - 2(N-1) items (∈ [2, 3]).
  const totalPages =
    Math.ceil((safeTotal - CODEX_MAX_OPTIONS) / CODEX_PAGE_SIZE) + 1;

  const idx = Math.max(0, Math.min(pageIndex, totalPages - 1));
  const isLastPage = idx === totalPages - 1;
  const start = idx * CODEX_PAGE_SIZE;
  const end = isLastPage ? safeTotal : start + CODEX_PAGE_SIZE;

  return {
    start,
    end,
    isLastPage,
    count: end - start,
    totalPages,
    total: safeTotal,
  };
}
