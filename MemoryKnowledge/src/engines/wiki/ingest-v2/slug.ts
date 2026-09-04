/**
 * slug.ts — Entity name -> stable filename slug
 *
 * Basis for dedup (deduplication & merging): ingesting the same entity name twice must produce the same slug,
 * so the second ingest hits the existing `wiki/<type>/<slug>.md` to merge rather than create new.
 *
 * Rules (PRD FR-4 / INTERFACE §2, mixed Chinese/English source):
 *   - English/digits: lowercase, convert spaces and punctuation to hyphens, trim leading/trailing/duplicate hyphens.
 *   - Chinese (CJK): preserve CJK characters as-is, remove spaces only (no pinyin conversion, no dropping).
 *   - Mixed: process separately per rules above and concatenate (`Redis 主从` -> `redis-主从`).
 */

// CJK Unified Ideographs (including Extension A) + common Chinese punctuation not listed here (punctuation handled as delimiter).
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function isCjkChar(ch: string): boolean {
  return CJK_RE.test(ch);
}

function isAlnumChar(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch);
}

/**
 * Normalizes entity name/title into a stable slug.
 *
 * Implementation strategy: scan character by character, splitting into alternating "CJK segments" and "Latin/digit segments"
 * connected by hyphens; lowercases Latin segments; all other characters (spaces, punctuation) act as segment boundaries.
 */
export function slugify(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";

  const tokens: string[] = [];
  let buf = "";
  let bufKind: "cjk" | "latin" | null = null;

  const flush = () => {
    if (buf) {
      tokens.push(bufKind === "latin" ? buf.toLowerCase() : buf);
      buf = "";
    }
    bufKind = null;
  };

  for (const ch of trimmed) {
    if (isCjkChar(ch)) {
      if (bufKind !== "cjk") flush();
      bufKind = "cjk";
      buf += ch;
    } else if (isAlnumChar(ch)) {
      if (bufKind !== "latin") flush();
      bufKind = "latin";
      buf += ch;
    } else {
      // Space / punctuation / other -> segment boundary
      flush();
    }
  }
  flush();

  // Join with hyphens, remove duplicate/leading/trailing hyphens.
  return tokens.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Given page type and title, returns relative path inside wiki (without leading `wiki/`).
 * For example type="entity", title="Redis Cluster" -> "entities/redis-cluster.md"
 *
 * type -> directory mapping aligns with existing manager directory conventions (entities/concepts/sources/...).
 */
const TYPE_DIR: Record<string, string> = {
  source: "sources",
  entity: "entities",
  concept: "concepts",
  comparison: "comparisons",
  synthesis: "synthesis",
  thesis: "synthesis",
  methodology: "concepts",
  finding: "synthesis",
};

/** Maps type to directory name; unknown types fall back to generic directory by pluralizing type. */
export function dirForType(type: string): string {
  const key = (type ?? "").trim().toLowerCase();
  return TYPE_DIR[key] ?? `${key || "other"}`;
}

/**
 * Calculates a page's relative wiki path (with `wiki/` prefix) for disk persistence and dedup matching.
 * @param type Page type (source/entity/concept/...)
 * @param title Entity name/title
 */
export function pageRelPath(type: string, title: string): string {
  const slug = slugify(title);
  const dir = dirForType(type);
  return `wiki/${dir}/${slug}.md`;
}
