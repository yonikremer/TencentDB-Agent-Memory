/**
 * skill-fast-path — name-substring quick-match channel.
 *
 * Design: docs/design/2026-06-30-skill-router.md §4.2
 *
 * An independent fast path executing in parallel with the main channel (BM25 / embedding / hybrid via ISkillStore.searchSkills).
 * When a skill name length is >= NAME_MATCH_MIN_LENGTH (default 4), and the user query (lowercased) contains the
 * skill name (substring match), the skill is hit by the fast path.
 *
 * Merge rules (implemented in handleListing):
 * - Skills hit by the fast path are placed at the top of the final results
 * - Main channel results are deduplicated and appended afterwards
 * - Does not enter the reranker, preventing disruption of the already-reranked main channel order
 *
 * Performance: Pure in-memory string operations, zero I/O, zero model inference; traversing 80k skills takes <5ms.
 *
 * DECISION (2026-06-30): Temporarily unintegrated. Evaluation conclusion:
 *   - fast-path requires fetching the full set first (name + description), in VDB mode HTTP fetching
 *     1000+ skills takes 80-150ms (same region) or more, far exceeding the <5ms of pure in-memory matching.
 *   - Main channel BM25/hybrid inherently heavily weights the name field (FTS5 name column position 0),
 *     when the user mentions the name, the main channel is highly likely to hit top-K already.
 *   - Benefits are limited (only serves the edge case of "user explicitly mentioning the skill name") but costs
 *     2~6 times the query time (search + full list + memory match vs single search).
 *   Keeping file for later re-evaluation if data proves recall is insufficient.
 */
import type { Skill } from "./types.js";

export const DEFAULT_NAME_MATCH_MIN_LENGTH = 4;

/**
 * Returns skills from `skills` where `name` length is >= `minLength` and the query (lowercased) contains the name (lowercased).
 * Empty queries or all-whitespace short-circuit and return `[]`.
 */
export function nameMatchFastPath(
  query: string,
  skills: Skill[],
  minLength: number = DEFAULT_NAME_MATCH_MIN_LENGTH,
): Skill[] {
  const q = (query ?? "").toLowerCase().trim();
  if (q === "") return [];
  return skills.filter(
    (s) => s.name.length >= minLength && q.includes(s.name.toLowerCase()),
  );
}
