/**
 * index.ts — Ingest engine entry.
 *
 * Two-stage model (wiki-ingest-optimization):
 *   1. extractSource() — Pure LLM extraction, returning candidate pages Map (concurrentable)
 *   2. commitCandidates() — Serial merge + disk write + index.md/log.md finalize
 *
 * ingestSource() remains as a thin wrapper (= extract + commit serially), leaving existing unit tests/external calls unchanged.
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { LimitFunction } from "p-limit";
import { createLlmClient, normalizeLlmConfig, type LlmClient, type RawLlmConfig } from "./llm.js";
import { loadTemplate } from "./template.js";
import {
  buildSystemPrompt,
  buildGeneratePrompt,
  buildAnalysisSystemPrompt,
  buildAnalysisPrompt,
  buildGenerateFromAnalysisPrompt,
  type ExistingPageInfo,
} from "./prompts.js";
import { parseFileBlocks } from "./file-protocol.js";
import { parseFrontmatter, buildPage } from "./frontmatter.js";
import { mergePage, type MergeOptions } from "./merge.js";
import { chunkText } from "./chunker.js";
import { slugify, dirForType } from "./slug.js";
import { rebuildIndexFile } from "./index-builder.js";
import { appendIngestLog, appendIngestLogBatch } from "./log-writer.js";
import { createLogger } from "../../../logger.js";

const log = createLogger("wiki-ingest");

/** Dumps raw text to disk on generate parse failure to facilitate FILE protocol troubleshooting (does not alter success path). */
export function dumpGenerateFailure(args: {
  projectPath: string;
  sourceName: string;
  chunkTag: string;
  output: string;
  reason: string;
}): string | null {
  const { projectPath, sourceName, chunkTag, output, reason } = args;
  try {
    const debugDir = join(projectPath, "_debug");
    mkdirSync(debugDir, { recursive: true });
    const safeSource = sourceName.replace(/[^\w.\-]+/g, "_");
    const safeChunk = chunkTag.replace(/[^\w.\-#]+/g, "_");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(debugDir, `generate-fail-${safeSource}-${safeChunk}-${ts}.txt`);
    const header = [
      `# generate failure dump`,
      `# source=${sourceName}`,
      `# chunk=${chunkTag}`,
      `# reason=${reason}`,
      `# outputChars=${output.length}`,
      `# dumpedAt=${new Date().toISOString()}`,
      ``,
      ``,
    ].join("\n");
    writeFileSync(file, header + output, "utf-8");
    return file;
  } catch (err) {
    log.warn("Failed to dump generate failure raw text to disk", { source: sourceName, error: String(err) });
    return null;
  }
}

/** Structural files not allowed for ingest write/overwrite (PRD §3.7-2). */
const STRUCTURAL_FILES = new Set([
  "wiki/index.md",
  "wiki/schema.md",
  "wiki/purpose.md",
  "wiki/log.md",
  "wiki/overview.md",
]);

/** Rough context budget (chars): reserve margin for prompt frame and output. */
export const SOURCE_CHAR_BUDGET = 28_000;

export interface IngestOptions {
  /** Injected LLM client (for testing); if unprovided, constructs real client with llmConfig. */
  llm?: LlmClient;
  /** When old page body exceeds this char limit during merge, fallback to append mode (OQ-1); uses merge default if omitted. */
  mergeFullRewriteMaxChars?: number;
  /**
   * Ingestion flow (OQ-4):
   *   - "two-stage" (default): Analyze first (extraction plan) then generate FILE blocks, higher quality stability.
   *   - "single-stage": Full source directly produces FILE blocks (saves 1 LLM call, saves tokens).
   */
  mode?: "two-stage" | "single-stage";
  /**
   * Retrieval-augmented ingestion: Retrieval function injected by caller (manager).
   * Called once per source chunk text, returning existing page body context related to that chunk—implementing "per-chunk retrieval",
   * rather than once for entire file with all chunks sharing identical context. After splitting long documents, each chunk retrieves
   * using its own high-frequency words, better matching existing pages truly depended upon by that chunk. Empty string = no augmentation (any failure degrades to empty string).
   */
  retrieveContext?: (chunkText: string) => string;
}

export interface CommitResult {
  written: string[];
  /** Per-page merge error records in merge stage (does not affect other pages) */
  mergeErrors: Array<{ relPath: string; source: string; error: string }>;
}

export interface CommitOptions extends MergeOptions {
  /** Global LLM semaphore (LLM merge calls inside mergePage throttled under this limit) */
  globalLlmLimit?: LimitFunction;
  /** Skip batch log writing (thin wrapper caller handles single-source log writing externally) */
  skipLog?: boolean;
}

/**
 * Stage 1: Calls LLM for a single source file to generate candidate wiki pages (pure in-memory, no disk write).
 * Safe for concurrent execution.
 *
 * Empty candidate semantics: candidates.size === 0 is treated as failure (throw), consistent with existing behavior.
 */
export async function extractSource(
  projectPath: string,
  sourcePath: string,
  llmConfig: RawLlmConfig,
  existingPages: ExistingPageInfo[],
  options: IngestOptions = {},
): Promise<Map<string, string>> {
  if (!existsSync(sourcePath)) throw new Error(`Source file does not exist: ${sourcePath}`);
  const sourceText = readFileSync(sourcePath, "utf-8");
  const sourceName = basename(sourcePath);
  if (!sourceText.trim()) throw new Error(`Source file is empty: ${sourceName}`);

  const llm = options.llm ?? createLlmClient(normalizeLlmConfig(llmConfig));
  const template = loadTemplate(projectPath);
  const systemPrompt = buildSystemPrompt(template);
  const mode = options.mode ?? "two-stage";

  const chunks =
    sourceText.length > SOURCE_CHAR_BUDGET
      ? chunkText(sourceText, { targetChars: SOURCE_CHAR_BUDGET })
      : [sourceText];

  log.info("extractSource start", {
    source: sourceName,
    sourceChars: sourceText.length,
    mode,
    chunks: chunks.length,
    existingPages: existingPages.length,
    templateCustomized: template.customized,
  });

  const candidates = new Map<string, string>();
  const warnings: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkLabel = chunks.length > 1 ? `${sourceName} (chunk ${i + 1}/${chunks.length})` : sourceName;
    const tag = chunks.length > 1 ? `${sourceName}#${i + 1}` : sourceName;

    // Retrieval-augmented ingestion: per-chunk retrieval—each chunk searches relevant existing pages with its own text (rather than once per whole file).
    // Any failure degrades to no augmentation for that chunk, never blocking extraction of that chunk.
    let retrievalContext = "";
    if (options.retrieveContext) {
      try {
        retrievalContext = options.retrieveContext(chunks[i]);
      } catch (err) {
        log.warn("Per-chunk retrieval augmentation failed, chunk degraded to no augmentation", { chunk: tag, error: err instanceof Error ? err.message : String(err) });
      }
    }

    let out: string;
    if (mode === "two-stage") {
      log.debug("Stage A analysis start", { chunk: tag });
      const analysis = await llm.chat({
        system: buildAnalysisSystemPrompt(template),
        prompt: buildAnalysisPrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages, retrievalContext }),
        label: `analysis:${tag}`,
      });
      log.debug("Stage A analysis complete", { chunk: tag, analysisChars: analysis.length, empty: !analysis.trim() });
      log.debug("Stage A analysis preview", { chunk: tag, preview: analysis.slice(0, 200) });
      const genPrompt = analysis.trim()
        ? buildGenerateFromAnalysisPrompt({ sourceName: chunkLabel, sourceText: chunks[i], analysis, existingPages, retrievalContext })
        : buildGeneratePrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages, retrievalContext });
      if (!analysis.trim()) log.warn("Analysis empty, fallback to single-stage generation", { chunk: tag });
      out = await llm.chat({ system: systemPrompt, prompt: genPrompt, label: `generate:${tag}` });
    } else {
      const prompt = buildGeneratePrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages, retrievalContext });
      out = await llm.chat({ system: systemPrompt, prompt, label: `generate:${tag}` });
    }

    const { files, warnings: w } = parseFileBlocks(out);
    warnings.push(...w);
    log.debug("FILE block parsing", { chunk: tag, outChars: out.length, files: files.length, warnings: w.length });
    if (files.length === 0 && out.trim()) {
      const dumpPath = dumpGenerateFailure({
        projectPath,
        sourceName,
        chunkTag: tag,
        output: out,
        reason: w.length ? `parse_empty warnings=${w.length}` : "parse_empty files=0",
      });
      if (dumpPath) log.warn("generate has no valid FILE, dumped to disk", { source: sourceName, dumpPath });
    }
    for (const f of files) {
      const canonicalPath = canonicalizePagePath(f.path, f.content);
      if (STRUCTURAL_FILES.has(canonicalPath)) {
        warnings.push(`Skip structural file: ${canonicalPath}`);
        continue;
      }
      candidates.set(canonicalPath, ensureSources(f.content, sourceName));
    }
  }

  if (candidates.size === 0) {
    log.error("No valid wiki pages generated", { source: sourceName, warnings });
    throw new Error(
      `Failed to generate any valid wiki pages (no files generated): ${sourceName}${warnings.length ? ` [${warnings.join("; ")}]` : ""}`,
    );
  }

  log.info("extractSource complete", { source: sourceName, candidates: candidates.size, warnings: warnings.length });
  return candidates;
}

/**
 * Stage 2: Serial disk write + finalize.
 * - Aggregates candidate pages produced by all sources by relPath, merging page by page.
 * - Per-page try/catch: single page merge failure does not block other pages.
 * - mergePage internally may call LLM, throttled under global rate limit via globalLlmLimit.
 * - Runs rebuildIndexFile + appendIngestLogBatch once after all disk writes complete.
 */
export async function commitCandidates(
  projectPath: string,
  allCandidates: Array<{ sourceFilename: string; candidates: Map<string, string> }>,
  /** Omit when no candidates exist (only rebuild index); when candidates exist but LLM missing, record corresponding page into mergeErrors. */
  llm: LlmClient | undefined,
  options?: CommitOptions,
): Promise<CommitResult> {
  const { globalLlmLimit, skipLog, ...mergeOpts } = options ?? {};

  const byPage = new Map<string, Array<{ source: string; content: string }>>();
  for (const { sourceFilename, candidates } of allCandidates) {
    for (const [relPath, content] of candidates) {
      if (!byPage.has(relPath)) byPage.set(relPath, []);
      byPage.get(relPath)!.push({ source: sourceFilename, content });
    }
  }

  const written: string[] = [];
  const mergeErrors: CommitResult["mergeErrors"] = [];

  for (const [relPath, entries] of byPage) {
    const fullPath = join(projectPath, relPath);
    let existing = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : null;

    for (const entry of entries) {
      if (!llm) {
        mergeErrors.push({
          relPath,
          source: entry.source,
          error: "LLM client unavailable",
        });
        continue;
      }
      try {
        const decision = globalLlmLimit
          ? await globalLlmLimit(() => mergePage(existing, entry.content, llm, mergeOpts))
          : await mergePage(existing, entry.content, llm, mergeOpts);
        if (decision.action === "skip") {
          log.debug("Skip page (locked)", { relPath, source: entry.source });
          continue;
        }
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, decision.content, "utf-8");
        existing = decision.content;
        if (!written.includes(relPath)) written.push(relPath);
        log.debug("Disk write", { relPath, source: entry.source, bytes: decision.content.length });
      } catch (err) {
        mergeErrors.push({ relPath, source: entry.source, error: String(err) });
        log.error("Page merge failed", { relPath, source: entry.source, error: String(err) });
      }
    }
  }

  try {
    rebuildIndexFile(projectPath);
  } catch (err) {
    log.warn("index.md rebuild failed (does not affect main workflow)", { error: String(err) });
  }

  try {
    if (!skipLog) {
      appendIngestLogBatch(projectPath, {
        sourcesProcessed: allCandidates.map((c) => c.sourceFilename),
        pagesWritten: written,
        mergeErrors: mergeErrors.map((e) => `${e.relPath} (from ${e.source}): ${e.error}`),
      });
    }
  } catch (err) {
    log.warn("log.md write failed (does not affect main workflow)", { error: String(err) });
  }

  return { written, mergeErrors };
}

/**
 * Single-source full workflow (extract + merge + index.md + log.md),
 * equivalent to serial combination of extractSource → commitCandidates.
 * Existing unit tests and external direct calls require no changes.
 */
export async function ingestSource(
  projectPath: string,
  sourcePath: string,
  llmConfig: RawLlmConfig,
  options: IngestOptions = {},
): Promise<string[]> {
  const existingPages = scanExistingPages(projectPath);
  const candidates = await extractSource(projectPath, sourcePath, llmConfig, existingPages, options);
  const llm = options.llm ?? createLlmClient(normalizeLlmConfig(llmConfig));
  const sourceName = basename(sourcePath);
  const { written } = await commitCandidates(
    projectPath,
    [{ sourceFilename: sourceName, candidates }],
    llm,
    { fullRewriteMaxChars: options.mergeFullRewriteMaxChars, skipLog: true },
  );
  if (written.length === 0) {
    log.warn("No pages written (all locked skipped)", { source: sourceName });
    return [];
  }
  try {
    appendIngestLog(projectPath, sourceName, written.length);
  } catch (err) {
    log.warn("log.md append failed", { error: err instanceof Error ? err.message : String(err) });
  }
  log.info("ingestSource complete", { source: sourceName, written: written.length });
  return written;
}

/** Scans wiki/ to get lightweight info of existing pages (for LLM to judge create/update). Excludes structural files. */
export function scanExistingPages(projectPath: string): ExistingPageInfo[] {
  const wikiDir = join(projectPath, "wiki");
  if (!existsSync(wikiDir)) return [];
  const out: ExistingPageInfo[] = [];
  walk(wikiDir, wikiDir, out);
  return out;
}

function walk(baseDir: string, dir: string, out: ExistingPageInfo[]): void {
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
      if (entry !== "media") walk(baseDir, full, out);
    } else if (entry.endsWith(".md")) {
      const rel = `wiki/${full.slice(baseDir.length + 1).replace(/\\/g, "/")}`;
      if (STRUCTURAL_FILES.has(rel)) continue;
      try {
        const content = readFileSync(full, "utf-8");
        const { frontmatter } = parseFrontmatter(content);
        out.push({
          relPath: rel,
          title: typeof frontmatter.title === "string" ? frontmatter.title : basename(entry, ".md"),
          type: frontmatter.type,
          description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
        });
      } catch {
        /* Skip malformed page */
      }
    }
  }
}

/**
 * Ensures sources array in candidate page frontmatter contains at least the current source filename (§3.7-3 / AC-10).
 * LLM might omit or write wrong sources, forcibly backfill current source here.
 */
export function ensureSources(content: string, sourceName: string): string {
  const parsed = parseFrontmatter(content);
  const cur = Array.isArray(parsed.frontmatter.sources)
    ? parsed.frontmatter.sources.filter((x): x is string => typeof x === "string")
    : [];
  if (cur.includes(sourceName)) return content;
  return buildPage({ ...parsed.frontmatter, sources: [...cur, sourceName] }, parsed.body);
}

/**
 * OQ-6: Canonicalizes page disk path to guarantee dedup stability.
 *
 * The path chosen by LLM (e.g. `wiki/entity/redis.md`) might disagree with our directory convention (`wiki/entities/redis.md`),
 * or give different slugs for the same entity across different ingest runs, breaking the "same entity → same path" dedup invariant.
 *
 * Strategy: Preferably use page frontmatter `type` + `title` to derive canonical path via `pageRelPath`
 * (directory determined by type, filename determined by title slug, matching dedup hit logic).
 * When frontmatter lacks type/title, fallback to "canonicalizing directory segment of LLM original path"—
 * i.e., normalize directory via `dirForType` (entity→entities), reusing original slug for filename.
 *
 * @param llmPath  Path declared by LLM in FILE block (passed normalizeWikiPath whitelist validation)
 * @param content  Complete page content (including frontmatter)
 * @returns Normalized wiki relative path (always starting with `wiki/`)
 */
export function canonicalizePagePath(llmPath: string, content: string): string {
  const { frontmatter } = parseFrontmatter(content);
  const type = typeof frontmatter.type === "string" ? frontmatter.type.trim() : "";
  const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";

  if (type && title) {
    const slug = slugify(title);
    if (slug) return `wiki/${dirForType(type)}/${slug}.md`;
  }

  // LLM output is a POSIX-style wiki path, but models on Windows hosts may
  // emit backslashes — normalize first so both parse identically.
  const posixPath = llmPath.replace(/\\/g, "/");
  const segments = posixPath.split("/");
  const fileName = segments[segments.length - 1];
  if (segments.length >= 3) {
    const dirSeg = segments[1];
    const canonicalDir = type ? dirForType(type) : dirForType(dirSeg);
    const middle = segments.slice(2, -1);
    return ["wiki", canonicalDir, ...middle, fileName].join("/");
  }
  return posixPath;
}
