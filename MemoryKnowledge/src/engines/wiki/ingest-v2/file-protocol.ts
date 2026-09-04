/**
 * file-protocol.ts — Parses FILE block protocol output by LLM and validates disk paths.
 *
 * LLMs cannot write files freely; it outputs text protocol with boundary tags, which we parse before writing to disk:
 *
 *   <<<FILE path="wiki/sources/redis.md">>>
 *   ---
 *   type: source
 *   ...
 *   ---
 *   Body...
 *   <<<END>>>
 *
 * A single response can contain multiple FILE blocks. Parsing must be fault-tolerant (INTERFACE §5.1 / §7):
 *   - Discards unclosed blocks (common when truncated / exceeding token limit).
 *   - Invalid paths (outside wiki/, containing .., absolute paths) are skipped and logged, without throwing errors.
 */

export interface ParsedFile {
  /** Normalized relative path, guaranteed to be inside wiki/ (e.g. "wiki/entities/redis.md"). */
  path: string;
  /** Complete file content (including frontmatter). */
  content: string;
}

export interface ParseResult {
  files: ParsedFile[];
  /** Reasons for skipped/discarded blocks, used for logging and debugging. */
  warnings: string[];
}

/**
 * Opening tag: Standard is >>>; model occasionally misses one > into >>.
 * Accepts ≥2 trailing >, avoiding "long output but files=0".
 */
const OPEN_RE = /<<<FILE\s+path\s*=\s*"([^"]*)"\s*>>+/g;
/**
 * Closing tag: Standard is <<<END>>>; model occasionally splits into <<<\nEND>>>.
 * Only relaxes whitespace on both sides of END (including newlines), still requiring literal END.
 */
const CLOSE_RE = /<<<\s*END\s*>>>/g;

/**
 * Validates and normalizes declared path of a FILE block.
 * Returns normalized path (POSIX style, wiki/ prefix) or null (invalid, should skip).
 *
 * Rules:
 *   - Must be a relative path (rejects absolute paths / drive letters).
 *   - No segment after splitting may be ".." or "." (prevents traversal).
 *   - Must start with "wiki/" after normalization (only permits writing under wiki/**).
 */
export function normalizeWikiPath(raw: string): string | null {
  if (!raw) return null;
  // Normalize separator to /
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return null;
  // Reject absolute paths and Windows drive letters
  if (p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) return null;
  // Remove redundant ./ prefix
  p = p.replace(/^(\.\/)+/, "");
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  // Prevent traversal: reject if any segment is .. or .
  for (const seg of segments) {
    if (seg === ".." || seg === ".") return null;
  }
  const normalized = segments.join("/");
  // Whitelist: only allow writing to wiki/** (and cannot be "wiki" directory itself)
  if (normalized !== "wiki" && !normalized.startsWith("wiki/")) return null;
  if (normalized === "wiki") return null;
  return normalized;
}

/**
 * Parses LLM output text and extracts all valid FILE blocks.
 *
 * @param text Raw LLM response text
 * @returns List of valid files + warnings (skipped blocks)
 */
export function parseFileBlocks(text: string): ParseResult {
  const files: ParsedFile[] = [];
  const warnings: string[] = [];
  if (!text) return { files, warnings };

  OPEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = OPEN_RE.exec(text)) !== null) {
    const rawPath = match[1];
    const bodyStart = OPEN_RE.lastIndex;
    CLOSE_RE.lastIndex = bodyStart;
    const closeMatch = CLOSE_RE.exec(text);

    if (!closeMatch) {
      // Unclosed block → discard (usually truncated output)
      warnings.push(`Unclosed FILE block, discarded: path="${rawPath}"`);
      break;
    }

    // Prevent next match from crossing current block's END
    const closeIdx = closeMatch.index;
    const rawContent = text.slice(bodyStart, closeIdx);
    OPEN_RE.lastIndex = closeIdx + closeMatch[0].length;

    const normPath = normalizeWikiPath(rawPath);
    if (!normPath) {
      warnings.push(`Invalid path skipped: "${rawPath}"`);
      continue;
    }

    // Remove leading/trailing extra blank lines in block content, preserving frontmatter structure.
    const content = stripBlockEdges(rawContent);
    if (!content.trim()) {
      warnings.push(`Empty FILE block skipped: "${normPath}"`);
      continue;
    }

    files.push({ path: normPath, content });
  }

  return { files, warnings };
}

/** Strips leading newline and trailing excess whitespace from block, ensuring single trailing newline. */
function stripBlockEdges(raw: string): string {
  // Remove first newline immediately following >>>
  let s = raw.replace(/^\r?\n/, "");
  // Remove trailing whitespace
  s = s.replace(/\s+$/, "");
  if (!s) return "";
  return s + "\n";
}
