/**
 * log-writer.ts — Maintains wiki/log.md ingestion log (OKF §7 / llm-wiki timeline, OQ-10).
 *
 * Appends a date-grouped entry for each ingested source, newest first for easy grepping and manual tracing:
 *   ## YYYY-MM-DD
 *   * **ingest** <source filename> — wrote N pages
 *
 * Batch ingest additionally has:
 *   * **batch-ingest** N sources (...) — wrote M pages
 *
 * log.md is a structural file (page/write/rm cannot modify it), but ingest can maintain it.
 * No frontmatter (OKF convention). Plain text append, no LLM calls.
 *
 * In-house implementation, no GPL code referenced.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const HEADER = "# Ingest Log";

/** Get local date YYYY-MM-DD. */
function today(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Renders a log entry line. Exported for unit testing.
 */
export function renderLogEntry(sourceName: string, pageCount: number): string {
  return `* **ingest** ${sourceName} — wrote ${pageCount} pages`;
}

/** Renders a batch ingest log line. */
export function renderBatchLogEntry(sourcesProcessed: string[], pageCount: number): string {
  const list = sourcesProcessed.join(", ");
  return `* **batch-ingest** ${sourcesProcessed.length} sources (${list}) — wrote ${pageCount} pages`;
}

function readLogBody(logPath: string): string {
  if (!existsSync(logPath)) return "";
  try {
    return readFileSync(logPath, "utf-8");
  } catch {
    return "";
  }
}

function appendEntries(projectPath: string, entries: string[], now: Date): void {
  const logPath = join(projectPath, "wiki", "log.md");
  const day = today(now);
  let body = readLogBody(logPath);
  for (const entry of entries) {
    body = mergeEntry(body, day, entry);
  }
  writeFileSync(logPath, body, "utf-8");
}

/**
 * Appends an ingestion log entry to wiki/log.md (newest date group first).
 *
 * @param projectPath wiki project root
 * @param sourceName  Source filename ingested this time
 * @param pageCount   Number of pages written/updated this time
 * @param now         Injected timestamp (for testing)
 */
export function appendIngestLog(
  projectPath: string,
  sourceName: string,
  pageCount: number,
  now = new Date(),
): void {
  appendEntries(projectPath, [renderLogEntry(sourceName, pageCount)], now);
}

export interface BatchIngestLogInput {
  sourcesProcessed: string[];
  pagesWritten: string[];
  mergeErrors: string[];
}

/**
 * Batch aggregated log (one batch record per ingest run, optional merge-errors).
 * Coexists with appendIngestLog, written to the same wiki/log.md.
 */
export function appendIngestLogBatch(
  projectPath: string,
  input: BatchIngestLogInput,
  now = new Date(),
): void {
  const entries = [
    renderBatchLogEntry(input.sourcesProcessed, input.pagesWritten.length),
  ];
  for (const err of input.mergeErrors) {
    entries.push(`* **merge-errors** ${err}`);
  }
  appendEntries(projectPath, entries, now);
}

/**
 * Merges a log entry into log text: if today's date group exists, prepend to that group;
 * otherwise create today's date group after the header.
 * Newest date group is always at the top. Exported for unit testing.
 */
export function mergeEntry(existing: string, day: string, entry: string): string {
  const dayHeading = `## ${day}`;
  const lines = (existing || `${HEADER}\n`).split("\n");

  // Find header line index (add if missing).
  let headerIdx = lines.findIndex((l) => l.trim() === HEADER);
  if (headerIdx === -1) {
    lines.unshift(HEADER, "");
    headerIdx = 0;
  }

  // Find today's date group.
  const dayIdx = lines.findIndex((l) => l.trim() === dayHeading);
  if (dayIdx !== -1) {
    // Prepend to the line after today's group heading (top of that group).
    lines.splice(dayIdx + 1, 0, entry);
  } else {
    // Insert new date group after header (and any following blank lines), so it precedes all old date groups.
    let insertAt = headerIdx + 1;
    if (lines[insertAt]?.trim() === "") insertAt++;
    lines.splice(insertAt, 0, dayHeading, entry, "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "") + "\n";
}
