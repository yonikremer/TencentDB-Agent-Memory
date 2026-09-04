/**
 * index-builder.ts — Maintains wiki/index.md (OKF §6 progressive disclosure / llm-wiki "browse index before drilling down").
 *
 * Called after ingest disk write: scans frontmatter of all pages under wiki/, groups by page type,
 * generates `* [Title](relPath) - Description` list, and overwrites wiki/index.md.
 *
 * Design trade-offs:
 *   - index.md is a structural file (forbidden to edit via page/write/rm), but ingest can maintain it (PRD §3.7-2).
 *   - Uses standard markdown links (OKF recommended bundle-relative `/path`), without affecting [[wikilink]] graph.
 *   - Grouping order fixed (sources → entities → concepts → other types), sorted by title within group for stable output.
 *   - Tolerant: skips malformed pages / missing frontmatter without throwing.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

/** Structural files not listed in index. */
const STRUCTURAL = new Set(["index.md", "schema.md", "purpose.md", "log.md", "overview.md"]);

/** Group display order and section headings. Unknown types fall back to "Other". */
const GROUP_ORDER: Array<{ type: string; heading: string }> = [
  { type: "source", heading: "Sources" },
  { type: "entity", heading: "Entities" },
  { type: "concept", heading: "Concepts" },
  { type: "comparison", heading: "Comparisons" },
  { type: "synthesis", heading: "Synthesis" },
];

interface IndexEntry {
  title: string;
  relPath: string; // bundle-relative, starting with / (OKF recommended)
  description: string;
  type: string;
}

/** Scans wiki/ to collect index entries of all non-structural pages. */
function collectEntries(wikiDir: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry !== "media") walk(full);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const rel = relative(wikiDir, full).replace(/\\/g, "/");
      if (STRUCTURAL.has(rel)) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      const { frontmatter } = parseFrontmatter(content);
      const title =
        typeof frontmatter.title === "string" && frontmatter.title.trim()
          ? frontmatter.title.trim()
          : entry.replace(/\.md$/, "");
      const description =
        typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
      out.push({ title, relPath: `/${rel}`, description, type: frontmatter.type });
    }
  };
  if (existsSync(wikiDir)) walk(wikiDir);
  return out;
}

/**
 * Renders index.md text based on current wiki/ content (OKF progressive disclosure format, without frontmatter).
 * Exported for unit testing.
 */
export function renderIndex(entries: IndexEntry[]): string {
  const byType = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const arr = byType.get(e.type) ?? [];
    arr.push(e);
    byType.set(e.type, arr);
  }

  const sections: string[] = ["# Index", ""];
  const emitted = new Set<string>();

  const emitGroup = (type: string, heading: string) => {
    const items = byType.get(type);
    if (!items || items.length === 0) return;
    emitted.add(type);
    items.sort((a, b) => a.title.localeCompare(b.title));
    sections.push(`## ${heading}`, "");
    for (const it of items) {
      sections.push(`* [${it.title}](${it.relPath})${it.description ? ` - ${it.description}` : ""}`);
    }
    sections.push("");
  };

  for (const { type, heading } of GROUP_ORDER) emitGroup(type, heading);

  // Other unlisted types are grouped under their capitalized name, ensuring no pages are missed (OKF tolerates unknown types).
  const otherTypes = [...byType.keys()].filter((t) => !emitted.has(t)).sort();
  for (const t of otherTypes) emitGroup(t, t.charAt(0).toUpperCase() + t.slice(1));

  return sections.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Rebuilds and overwrites wiki/index.md.
 * @returns Count of written entries (for logging).
 */
export function rebuildIndexFile(projectPath: string): number {
  const wikiDir = join(projectPath, "wiki");
  if (!existsSync(wikiDir)) return 0;
  const entries = collectEntries(wikiDir);
  const text = renderIndex(entries);
  writeFileSync(join(wikiDir, "index.md"), text, "utf-8");
  return entries.length;
}
