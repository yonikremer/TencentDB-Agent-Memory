/**
 * cascade.ts — Cascade delete (downstream cleanup for raw/rm and page/rm).
 *
 * Behavior contract see PRD §3.7-3 and invocation signature of wiki-service.ts.
 *
 *  - deleteSourceFiles: Deletes raw source files, and cascades based on each page's frontmatter `sources`—
 *      Pages exclusively referencing the source → deleted; shared pages → rewritten to remove the source.
 *  - cascadeDeleteWikiPagesWithRefs: Deletes wiki page files, and cleans up [[wikilink]] dangling references
 *      pointing to deleted pages in remaining page body text.
 */

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { parseFrontmatter, buildPage } from "./frontmatter.js";
import { slugify } from "./slug.js";

export interface DeleteSourceFilesResult {
  /** Absolute paths of wiki pages cascaded for deletion. */
  deletedWikiPaths: string[];
  /** Count of wiki pages rewritten (source removed). */
  rewrittenSourcePages: number;
}

export interface DeleteSourceFilesOptions {
  /** Log tag for audit purposes only. */
  logReason?: string;
}

/** Recursively collects absolute paths of all .md pages under wiki/ (skipping media directory). */
function collectWikiPages(wikiDir: string): string[] {
  const out: string[] = [];
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
      } else if (entry.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  if (existsSync(wikiDir)) walk(wikiDir);
  return out;
}

/** Structural files do not participate in cascade deletion/rewriting. */
function isStructural(relFromWiki: string): boolean {
  return relFromWiki === "index.md" || relFromWiki === "schema.md" || relFromWiki === "purpose.md";
}

/**
 * Deletes raw source files and cascades cleanup of wiki pages referencing them.
 *
 * @param projectPath Wiki project root
 * @param sourceFullPaths List of absolute paths of raw source files to delete
 */
export async function deleteSourceFiles(
  projectPath: string,
  sourceFullPaths: string[],
  _opts: DeleteSourceFilesOptions = {},
): Promise<DeleteSourceFilesResult> {
  // Set of deleted source filenames (pages record filenames in their sources array).
  const deletedNames = new Set<string>();
  for (const p of sourceFullPaths) {
    deletedNames.add(basename(p));
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch {
      /* Delete failure ignored: may already be deleted */
    }
  }

  const wikiDir = join(projectPath, "wiki");
  const deletedWikiPaths: string[] = [];
  let rewrittenSourcePages = 0;

  for (const pagePath of collectWikiPages(wikiDir)) {
    const relFromWiki = relative(wikiDir, pagePath).replace(/\\/g, "/");
    if (isStructural(relFromWiki)) continue;

    let content: string;
    try {
      content = readFileSync(pagePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(content);
    const sources = Array.isArray(parsed.frontmatter.sources)
      ? parsed.frontmatter.sources.filter((x): x is string => typeof x === "string")
      : [];
    if (sources.length === 0) continue;

    const remaining = sources.filter((s) => !deletedNames.has(s));
    if (remaining.length === sources.length) continue; // Page does not reference deleted source

    if (remaining.length === 0) {
      // Exclusively references deleted source → delete page
      try {
        rmSync(pagePath, { force: true });
        deletedWikiPaths.push(pagePath);
      } catch {
        /* ignore */
      }
    } else {
      // Shared → rewrite to remove deleted source
      try {
        const rewritten = buildPage({ ...parsed.frontmatter, sources: remaining }, parsed.body);
        writeFileSync(pagePath, rewritten, "utf-8");
        rewrittenSourcePages++;
      } catch {
        /* ignore */
      }
    }
  }

  return { deletedWikiPaths, rewrittenSourcePages };
}

export interface CascadeDeletePagesResult {
  /** Absolute paths of wiki pages actually deleted. */
  deletedPaths: string[];
  /** Count of pages rewritten (cleared dangling wikilinks). */
  rewrittenFiles: number;
}

/** Derives identifiers that might be referenced by [[wikilink]] from page path and content (lowercase normalized). */
function linkAliasesFor(pagePath: string, content: string): Set<string> {
  const aliases = new Set<string>();
  const base = basename(pagePath, ".md");
  aliases.add(base.toLowerCase());
  aliases.add(slugify(base).toLowerCase());
  const { frontmatter } = parseFrontmatter(content);
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    aliases.add(frontmatter.title.trim().toLowerCase());
    aliases.add(slugify(frontmatter.title).toLowerCase());
  }
  return aliases;
}

/** Normalizes a wikilink target (removes |label, trims, converts to lowercase). */
function normalizeLinkTarget(raw: string): string {
  const target = raw.split("|")[0].trim();
  return target.toLowerCase();
}

/**
 * Deletes wiki page files and cleans up [[wikilink]] references in other page body text pointing to deleted pages.
 *
 * @param projectPath Wiki project root
 * @param pageFullPaths List of absolute paths of wiki pages to delete
 */
export async function cascadeDeleteWikiPagesWithRefs(
  projectPath: string,
  pageFullPaths: string[],
): Promise<CascadeDeletePagesResult> {
  const wikiDir = join(projectPath, "wiki");

  // Collect wikilink aliases of deleted pages before deletion for subsequent dangling link cleanup.
  const deletedAliases = new Set<string>();
  const toDelete = new Set(pageFullPaths.map((p) => p));
  for (const p of pageFullPaths) {
    let content = "";
    try {
      content = readFileSync(p, "utf-8");
    } catch {
      /* May not exist */
    }
    for (const a of linkAliasesFor(p, content)) deletedAliases.add(a);
  }

  // Execute deletion.
  const deletedPaths: string[] = [];
  for (const p of pageFullPaths) {
    try {
      if (existsSync(p)) {
        rmSync(p, { force: true });
        deletedPaths.push(p);
      }
    } catch {
      /* ignore */
    }
  }

  // Clean up [[wikilink]] references pointing to deleted pages in remaining pages: replace [[X]] / [[X|label]] with display text.
  let rewrittenFiles = 0;
  const linkRe = /\[\[([^\]]+?)\]\]/g;
  for (const pagePath of collectWikiPages(wikiDir)) {
    if (toDelete.has(pagePath)) continue;
    let content: string;
    try {
      content = readFileSync(pagePath, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(linkRe, (whole, inner: string) => {
      const target = normalizeLinkTarget(inner);
      if (deletedAliases.has(target)) {
        changed = true;
        // Preserve readable text: use label if |label exists, otherwise use original target name.
        const parts = String(inner).split("|");
        return (parts[1] ?? parts[0]).trim();
      }
      return whole;
    });
    if (changed) {
      try {
        writeFileSync(pagePath, next, "utf-8");
        rewrittenFiles++;
      } catch {
        /* ignore */
      }
    }
  }

  return { deletedPaths, rewrittenFiles };
}
