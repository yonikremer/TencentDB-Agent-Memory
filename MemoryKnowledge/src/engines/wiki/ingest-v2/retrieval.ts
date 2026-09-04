/**
 * retrieval.ts — Pure function helpers for retrieval-augmented ingestion.
 *
 * Purpose: Converts a source document to be ingested into a search query, and formats
 * retrieved existing wiki page bodies into a context block injectable into extraction prompt —
 * allowing sources that depend on prior documents ("assumes you've read the first 20") to actually
 * get prior knowledge during extraction, instead of just a page metadata list.
 *
 * This module contains pure functions only, without touching SQLite / LLM, facilitating unit tests.
 * Real retrieval orchestration (searchInternal + readPage) is completed inside closure in manager.ts's ingest(),
 * while this module is responsible for query construction and formatting.
 */

import { tokenize } from "../tokenize.js";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * Converts a source document into a search query string.
 *
 * Tokenizes source text (mixed Chinese/English, filtering stop words), selects top queryTerms
 * high-frequency terms in descending order of frequency, and joins them with spaces. ftsSearch will
 * tokenize again and perform `"term"* OR ...` expansion, so output token sequence has round-trip consistent semantics.
 *
 * Selecting by term frequency (instead of top N by order) avoids verbose introductory words at start of long documents,
 * achieving more focused hits.
 */
export function buildSearchQuery(sourceText: string, queryTerms: number): string {
  const n = Math.max(1, Math.floor(queryTerms));
  const counts = new Map<string, number>();
  for (const term of tokenize(sourceText)) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  // Map preserves insertion order; Array.prototype.sort is stable (ES2019+), preserving first appearance order on frequency tie.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked
    .slice(0, n)
    .map(([term]) => term)
    .join(" ");
}

export interface RetrievedPage {
  relPath: string;
  title: string;
  content: string;
}

/**
 * Formats retrieved page bodies into a context block for prompt injection.
 *
 * - Strips frontmatter from each page, keeping body only.
 * - Total output length is capped by maxChars (including block header); when budget is insufficient
 *   for a full block, attempts to truncate and append, stopping if still insufficient.
 * - Returns "" when pages is empty (no augmentation, equivalent to feature disabled).
 */
export function formatRetrievedPages(pages: RetrievedPage[], maxChars: number): string {
  if (pages.length === 0) return "";
  const budget = Math.max(1000, Math.floor(maxChars));
  const header = "## Relevant Existing Knowledge (previously ingested pages — treat as established facts)";
  const sep = "\n\n";
  const blocks: string[] = [];
  let used = header.length;
  for (const p of pages) {
    const { frontmatter, body } = parseFrontmatter(p.content);
    const title = p.title || (typeof frontmatter.title === "string" ? frontmatter.title : "") || p.relPath;
    const block = `### ${title} (${p.relPath})\n${body.trim()}`;
    const cost = block.length + sep.length;
    if (used + cost > budget) {
      const remaining = budget - used - sep.length;
      if (remaining > 40) blocks.push(`${block.slice(0, remaining).trimEnd()}…`);
      break;
    }
    blocks.push(block);
    used += cost;
  }
  if (blocks.length === 0) return "";
  return `${header}${sep}${blocks.join(sep)}`;
}
