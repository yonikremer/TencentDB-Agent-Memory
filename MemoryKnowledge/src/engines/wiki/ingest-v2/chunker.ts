/**
 * chunker.ts — Chunking for oversized sources.
 *
 * When source character count exceeds model context budget, split text into chunks to process sequentially,
 * leaving small overlap between chunks to maintain context continuity (INTERFACE §6).
 *
 * Splitting unit (OQ-5 optimization): Preferably split along markdown heading (`#`~`######`) boundaries,
 * keeping each semantic section intact within the same chunk as much as possible; oversized sections fallback
 * to splitting by blank-line paragraphs, and still oversized paragraphs are hard-split at last. Avoid abrupt truncation mid-sentence/mid-section.
 */

export interface ChunkOptions {
  /** Target character count ceiling per chunk (default 12000). */
  targetChars?: number;
  /** Overlap character count between chunks (default 400). */
  overlapChars?: number;
}

const DEFAULT_TARGET = 12_000;
const DEFAULT_OVERLAP = 400;

/**
 * Splits text into an array of "split units": each unit is preferably a complete markdown section
 * (from one heading line to right before the next heading line). Headingless starting text becomes an independent unit.
 * Units exceeding target are further subdivided by blank-line paragraphs, and still oversized paragraphs are hard-split.
 */
function splitIntoUnits(text: string, target: number): string[] {
  const lines = text.split("\n");
  // First split into sections by heading lines.
  const sections: string[] = [];
  let cur: string[] = [];
  const isHeading = (line: string) => /^#{1,6}\s+\S/.test(line);
  for (const line of lines) {
    if (isHeading(line) && cur.length > 0) {
      sections.push(cur.join("\n"));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) sections.push(cur.join("\n"));

  // Fallback subdivision for oversized sections: first by blank-line paragraphs, then hard-split.
  const units: string[] = [];
  for (const sec of sections) {
    const s = sec.trim();
    if (!s) continue;
    if (s.length <= target) {
      units.push(s);
      continue;
    }
    for (const para of s.split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p) continue;
      if (p.length <= target) {
        units.push(p);
      } else {
        for (let i = 0; i < p.length; i += target) units.push(p.slice(i, i + target));
      }
    }
  }
  return units;
}

/**
 * Aggregates text into multiple chunks. Each chunk preferably does not exceed targetChars, aggregated by markdown section boundaries.
 *
 * @returns Array of chunks; returns [] for empty input, returns single-element array if below threshold.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const target = Math.max(1000, opts.targetChars ?? DEFAULT_TARGET);
  const overlap = Math.max(0, Math.min(opts.overlapChars ?? DEFAULT_OVERLAP, Math.floor(target / 2)));

  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.length <= target) return [trimmed];

  const units = splitIntoUnits(trimmed, target);

  const chunks: string[] = [];
  let buf = "";
  for (const unit of units) {
    const candidate = buf ? `${buf}\n\n${unit}` : unit;
    if (candidate.length > target && buf) {
      chunks.push(buf);
      // Overlap: use last overlap characters of previous chunk as start of next chunk
      const tail = overlap > 0 ? buf.slice(-overlap) : "";
      buf = tail ? `${tail}\n\n${unit}` : unit;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** Roughly estimates token count of a string (conservative len/3). Used to judge whether chunking is needed. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 3);
}
