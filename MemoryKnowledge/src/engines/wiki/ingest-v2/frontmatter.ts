/**
 * frontmatter.ts — Parsing and construction of YAML frontmatter.
 *
 * Generated pages must carry valid YAML frontmatter (relied upon by existing manager scanWikiDir/BM25/graph):
 *   type (required) / title / sources (our extension) / description / tags / timestamp (OKF recommended)
 *
 * Provides:
 *   - parseFrontmatter: splits frontmatter object + body text from page content (for merge / reading locked state).
 *   - buildPage: constructs compliant page content from frontmatter fields + body text (for output / rewriting).
 *   - isLocked / readSources: convenience getters used by merge logic.
 *
 * Uses existing `yaml` dependency for parsing with tolerant consumption spirit (malformed frontmatter does not throw, handled as empty).
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface PageFrontmatter {
  type: string;
  title?: string;
  description?: string;
  sources?: string[];
  tags?: string[];
  timestamp?: string;
  locked?: boolean;
  /** Retains any extra fields during round-trip without loss (in line with OKF tolerant consumption). */
  [key: string]: unknown;
}

export interface ParsedPage {
  frontmatter: PageFrontmatter;
  body: string;
  /** Whether frontmatter block was successfully parsed. */
  hasFrontmatter: boolean;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Splits page content into frontmatter + body text. Returns `{type:"other"}` placeholder when frontmatter is missing.
 * Graces gracefully on parsing failure (malformed YAML) without throwing.
 */
export function parseFrontmatter(content: string): ParsedPage {
  const text = content ?? "";
  const m = text.match(FM_RE);
  if (!m) {
    return { frontmatter: { type: "other" }, body: text, hasFrontmatter: false };
  }
  const yamlText = m[1];
  const body = text.slice(m[0].length);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  if (!parsed || typeof parsed !== "object") {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  const fm = parsed as Record<string, unknown>;
  const type = typeof fm.type === "string" && fm.type.trim() ? fm.type : "other";
  return { frontmatter: { ...fm, type } as PageFrontmatter, body, hasFrontmatter: true };
}

/** Whether target page is manually locked by user (injected with locked:true by page/write). Locked page ingest must be skipped. */
export function isLocked(content: string): boolean {
  const { frontmatter } = parseFrontmatter(content);
  return frontmatter.locked === true;
}

/** Reads sources list declared in page (depended on by raw/rm cascade). */
export function readSources(content: string): string[] {
  const { frontmatter } = parseFrontmatter(content);
  const s = frontmatter.sources;
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Assembles frontmatter + body text into compliant page content.
 *
 * - `type` is required; fills "other" if missing (OKF: consumer tolerates unknown type).
 * - Never writes `locked` field (only injected by page/write; output pages do not carry locked).
 * - Fixed field order (type→title→description→sources→tags→timestamp→others) for stable readability.
 */
export function buildPage(frontmatter: PageFrontmatter, body: string): string {
  const fm: Record<string, unknown> = {};
  fm.type = (frontmatter.type ?? "other").toString();
  if (frontmatter.title != null) fm.title = frontmatter.title;
  if (frontmatter.description != null) fm.description = frontmatter.description;
  if (frontmatter.sources != null) fm.sources = frontmatter.sources;
  if (frontmatter.tags != null) fm.tags = frontmatter.tags;
  if (frontmatter.timestamp != null) fm.timestamp = frontmatter.timestamp;
  // Pass through other custom fields (excluding locked / already processed fields)
  for (const [k, v] of Object.entries(frontmatter)) {
    if (["type", "title", "description", "sources", "tags", "timestamp", "locked"].includes(k)) continue;
    if (v != null) fm[k] = v;
  }

  const yamlText = stringifyYaml(fm).trimEnd();
  const cleanBody = (body ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
  return `---\n${yamlText}\n---\n\n${cleanBody}\n`;
}
