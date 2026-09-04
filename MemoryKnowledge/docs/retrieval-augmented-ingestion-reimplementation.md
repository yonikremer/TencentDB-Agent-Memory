# Handoff: Retrieval-Augmented Wiki Ingestion (final state, per-chunk)

> Purpose: enable an offline model with no memory of the original conversation to
> recreate this feature from scratch and verify it is correct. Module: `don/`
> of the TencentDB-Agent-Memory repo. Recreate the **final** state described here;
> an earlier once-per-file intermediate form exists in git history but must not be reproduced.

## 1. Goal and the problem it solves

The wiki ingest pipeline turns uploaded source documents into structured wiki pages via LLM
extraction. **Problem:** each source file is extracted *independently*. The extraction LLM sees:

- the source text, and
- a one-line metadata listing of existing pages (`relPath, title, type, description` — built by
  `scanExistingPages`).

It does **not** see the *content* of previously built pages. So a document that assumes prior
knowledge — e.g. a "vLLM KV-cache management" doc that assumes you know what a KV cache is —
produces pages that are missing or wrong on those implicit facts, because the definition lives only
in an earlier doc the extraction never read.

**Fix:** before extracting each *chunk* of a source, search the existing wiki for the most relevant
pages and inject their full content into the extraction prompt. The model then has real prior context.

**Key architectural fact that drives everything:** the FTS5 search index (`index.db` → `wiki_fts`)
is only rebuilt at the **end** of an ingest run. Therefore a retrieval during a run can only see the
pages of the **last completed** run. Consequence: to get cross-document context you must ingest in
**ordered batches across separate runs** (foundation docs first). A single giant ingest on an empty
wiki yields no augmentation (empty index) — by design.

## 2. Design decisions (why, so you don't blindly copy)

1. **Reuse the existing search surface.** The wiki already has `searchInternal` (BM25 over FTS5 +
   graph expansion) and page reading — the exact code behind `/v3/search` and the agent tools.
   Do not reimplement ranking; call those. The source/chunk text becomes the search query.
2. **Scale:** FTS5 lookup is O(log)-ish regardless of wiki size (unlike scanning every page's
   metadata, which is O(pages) per source and dies at 10k files).
3. **On by default, but bounded:** top 3 pages, ≤12,000 chars injected, per chunk. Overridable via env.
4. **Per-chunk, not per-file:** long files are chunked at ~28k chars; a whole-file query is diluted by
   the file's overall term frequencies and misses the specific pages each chunk depends on. So run the
   search **once per chunk**, using that chunk's text.
5. **Never fail an ingest because retrieval failed.** Every retrieval path degrades to "no augmentation".
6. **First ingest no-op:** empty index → search returns nothing → `""` injected → behavior identical
   to before the feature.

## 3. Files, in dependency order

All paths are under `MemoryKnowledge/`. "New" = create the file.

### 3a. NEW `src/engines/wiki/tokenize.ts`

Pure leaf module — CJK-aware tokenizer extracted out of `manager.ts` so both `manager.ts` and the new
retrieval module can use it without a circular import (manager already dynamically imports
`ingest-v2/index.js`).

```ts
const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
]);

export function tokenize(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…\[\]【】{}《》<>]+/)
    .filter((t) => t.length > 0);
  const result: string[] = [];
  for (const token of rawTokens) {
    const hasCJK = /[一-鿿㐀-䶿]/.test(token);
    const hasLatin = /[a-z]/.test(token);
    if (hasCJK && hasLatin) {
      const parts = token.split(/(?<=[a-z0-9])(?=[一-鿿])|(?<=[一-鿿])(?=[a-z0-9])/);
      for (const part of parts) {
        if (/[一-鿿]/.test(part) && part.length > 1) {
          const chars = [...part];
          for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
          result.push(part);
        } else if (part.length > 0 && !STOP_WORDS.has(part)) {
          result.push(part);
        }
      }
    } else if (hasCJK && token.length > 1) {
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
      result.push(token);
    } else if (!STOP_WORDS.has(token) && token.length > 0) {
      result.push(token);
    }
  }
  return result;
}
```

Semantics to preserve exactly: lowercase; split on whitespace + punctuation; English words kept whole,
stopwords dropped; pure CJK → bigram *and* whole token; mixed latin+CJK split at the boundary then each
part processed by its rule. (The `一-鿿㐀-䶿` escapes may be written as literal CJK
chars — identical codepoints.)

### 3b. MODIFY `src/engines/wiki/manager.ts` — remove tokenize

- Delete the `const STOP_WORDS = new Set([...])` block (it sat right after the
  `// ── Search Engine (SQLite FTS5) ──` header, before `const SNIPPET_CONTEXT = 80;`).
- Delete the whole `export function tokenize(...)` function plus its doc comment.
- Add the import near the other local imports and re-export so the public export name is unchanged:

  ```ts
  import { tokenize } from "./tokenize.js";
  export { tokenize };
  ```

### 3c. NEW `src/engines/wiki/ingest-v2/retrieval.ts`

Two pure helpers (no SQLite, no LLM — testable in isolation).

```ts
import { tokenize } from "../tokenize.js";
import { parseFrontmatter } from "./frontmatter.js";

export function buildSearchQuery(sourceText: string, queryTerms: number): string {
  const n = Math.max(1, Math.floor(queryTerms));
  const counts = new Map<string, number>();
  for (const term of tokenize(sourceText)) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]); // stable → ties keep first-occurrence
  return ranked.slice(0, n).map(([term]) => term).join(" ");
}

export interface RetrievedPage {
  relPath: string;
  title: string;
  content: string;
}

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
```

Why the query is frequency-ranked tokens joined by spaces: `ftsSearch` (in manager) re-tokenizes a
query and OR-expands each term to `"term"*`, so passing already-tokenized words round-trips correctly
against the FTS5 index. `formatRetrievedPages` strips frontmatter, caps total length at `maxChars`,
returns `""` for empty input.

### 3d. MODIFY `src/config.ts` — add four getters

Insert after `getGlobalLlmConcurrency` (the file already defines a `clamp(n, min, max)` helper):

```ts
export function getWikiRetrievalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.KNOWLEDGE_WIKI_RETRIEVAL_ENABLED;
  if (raw === undefined || raw === "") return true;   // default ON
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}
export function getWikiRetrievalTopK(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.KNOWLEDGE_WIKI_RETRIEVAL_TOP_K ?? "", 10);
  return clamp(Number.isNaN(raw) ? 3 : raw, 1, 10);
}
export function getWikiRetrievalMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.KNOWLEDGE_WIKI_RETRIEVAL_MAX_CHARS ?? "", 10);
  return clamp(Number.isNaN(raw) ? 12000 : raw, 1000, 60000);
}
export function getWikiRetrievalQueryTerms(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.KNOWLEDGE_WIKI_RETRIEVAL_QUERY_TERMS ?? "", 10);
  return clamp(Number.isNaN(raw) ? 24 : raw, 4, 100);
}
```

### 3e. MODIFY `src/engines/wiki/manager.ts` — wire retrieval in (the biggest change)

**Imports.** Extend the config import to include all four getters; add the retrieval helpers; add the
tokenize import/re-export. Order them (multi-line config import, then project-internal modules):

```ts
import {
  getIngestConcurrency,
  getWikiRetrievalEnabled,
  getWikiRetrievalTopK,
  getWikiRetrievalMaxChars,
  getWikiRetrievalQueryTerms,
} from "../../config.js";
import { buildSearchQuery, formatRetrievedPages, type RetrievedPage } from "./ingest-v2/retrieval.js";
import { slugify } from "./ingest-v2/slug.js";
import { DEFAULT_SCHEMA, DEFAULT_PURPOSE } from "./ingest-v2/template.js";
import { tokenize } from "./tokenize.js";

export { tokenize };
```

**1) `runIngestIncremental` — new optional 6th param.** Signature becomes:

```ts
export async function runIngestIncremental(
  projectPath: string,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
  llmConfig: any,
  onProgress?: ProgressFn,
  globalLlmLimit?: LimitFunction,
  retrieveContext?: (sourceText: string) => string,   // ← NEW
): Promise<IngestOutcome> {
```

**2) Per-source task** (inside `wikiLimit(async () => { ... })`). The function must be handed to
`extractSource` so `extractSource` can call it per chunk:

```ts
const candidates = await withSpan("ingest-source", async (span) => {
  span.setAttribute("source.name", d.filename);
  const run = () => extractSource(projectPath, d.abs, llmConfig, existingPages, { retrieveContext });
  return globalLlmLimit ? globalLlmLimit(run) : run();
});
```

Do **not** pre-compute a context from the whole file — that was the earlier once-per-file design and is
now wrong. If `retrieveContext` is `undefined` (feature disabled), `extractSource` injects nothing.

**3) In `ingest()`** (a factory-scope function inside `createWikiSourceManager`, which has
`searchInternal`, `sources`, etc. in scope), before the `runIngestIncremental(...)` call, build the
closure once per run:

```ts
let retrieveContext: ((sourceText: string) => string) | undefined;
if (getWikiRetrievalEnabled()) {
  const topK = getWikiRetrievalTopK();
  const maxChars = getWikiRetrievalMaxChars();
  const queryTerms = getWikiRetrievalQueryTerms();
  retrieveContext = (sourceText) => {
    try {
      const query = buildSearchQuery(sourceText, queryTerms);
      if (!query) return "";
      const res = searchInternal(name, query, topK, { hop: 0 });   // hop 0 = pure BM25
      const pages: RetrievedPage[] = [];
      for (const r of res.results) {
        const content = readPageInternal(name, r.path);
        if (content) pages.push({ relPath: r.path, title: r.title, content });
      }
      return formatRetrievedPages(pages, maxChars);
    } catch (err) {
      log.warn("wiki retrieval-augmented ingestion failed, degrading to no augmentation", { wiki: name, error: err instanceof Error ? err.message : String(err) });
      return "";
    }
  };
}
```

Then pass it as the 6th argument to `runIngestIncremental`.

**4) Extract `readPageInternal`.** The page-reading logic previously lived inline in the returned
object's `readPage`. But `ingest()` (a factory-scope function) can't see the returned object. Extract
it to a factory-scope function:

```ts
function readPageInternal(name: string, relPath: string): string | null {
  const state = sources.get(name);
  if (!state) return null;
  // raw/ prefix support (read from project root):
  if (relPath.startsWith("raw/")) {
    const fullPath = join(state.path, relPath);
    if (!fullPath.startsWith(join(state.path, "raw"))) return null;
    try { return readFileSync(fullPath, "utf-8"); } catch {}
    if (!relPath.endsWith(".md")) { try { return readFileSync(fullPath + ".md", "utf-8"); } catch {} }
    return null;
  }
  // accepts "wiki/concepts/x.md", "concepts/x.md", "concepts/x":
  const cleanPath = relPath.replace(/^wiki\//, "");
  const base = join(state.path, "wiki");
  let fullPath = join(base, cleanPath);
  if (!fullPath.startsWith(base)) return null;
  try { return readFileSync(fullPath, "utf-8"); } catch {}
  if (!cleanPath.endsWith(".md")) { try { return readFileSync(fullPath + ".md", "utf-8"); } catch {} }
  return null;
}
```

And replace the returned object's inline `readPage` body with:

```ts
readPage: (name, relPath) => readPageInternal(name, relPath),
```

### 3f. MODIFY `src/engines/wiki/ingest-v2/index.ts` — per-chunk retrieval in `extractSource`

**Export the chunk budget** (used by tests):

```ts
export const SOURCE_CHAR_BUDGET = 28_000;   // was `const`
```

**`IngestOptions`:** add one function option (this replaces an earlier string option; the final state
has only the function):

```ts
/**
 * Retrieval-augmented ingestion: retrieval function injected by the caller (manager).
 * Called once per source chunk text; returns existing page body context relevant to that chunk — per-chunk retrieval.
 * Empty string = that chunk is not augmented (any failure degrades to empty string).
 */
retrieveContext?: (chunkText: string) => string;
```

**`extractSource`:** remove any top-level `const retrievalContext = ...` (do not precompute once).
Inside the chunk loop, after computing `chunkLabel`/`tag`, before building prompts:

```ts
// Per-chunk retrieval: each chunk searches relevant existing pages with its own text (rather than once for the whole file, shared by all chunks).
let retrievalContext = "";
if (options.retrieveContext) {
  try {
    retrievalContext = options.retrieveContext(chunks[i]);
  } catch (err) {
    log.warn("Per-chunk retrieval augmentation failed, chunk degraded to no augmentation", { chunk: tag, error: err instanceof Error ? err.message : String(err) });
  }
}
```

Then pass that per-chunk `retrievalContext` into all three prompt builders:

- `buildAnalysisPrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages, retrievalContext })`
- `buildGeneratePrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages, retrievalContext })`
- `buildGenerateFromAnalysisPrompt({ sourceName: chunkLabel, sourceText: chunks[i], analysis, existingPages, retrievalContext })`

Single-chunk files: `chunks = [sourceText]`, so this behaves exactly like the once-per-file design.

### 3g. MODIFY `src/engines/wiki/ingest-v2/prompts.ts`

Add two module-level helpers, then thread an optional `retrievalContext?: string` through all three
builders (`buildAnalysisPrompt`, `buildGeneratePrompt`, `buildGenerateFromAnalysisPrompt`).

```ts
function retrievalSection(retrievalContext?: string): string {
  return retrievalContext && retrievalContext.trim() ? `\n\n${retrievalContext}` : "";
}

const RETRIEVAL_CONTEXT_RULE =
  '5. If "Relevant Existing Knowledge" is provided, treat it as authoritative context: facts referenced but not restated in the source come from there; link to those pages with [[title]] instead of duplicating their content.';
```

- `buildAnalysisPrompt(args)` — add `retrievalContext?: string`; render `${retrievalSection(retrievalContext)}`
  on its own line right after the existing-pages listing and before `## Source Document`.
- `buildGeneratePrompt(args)` — same addition after `${updateSection}`; append `\n${RETRIEVAL_CONTEXT_RULE}`
  after rule 4 in the numbered instructions.
- `buildGenerateFromAnalysisPrompt(args)` — same addition after the existing-pages listing; append
  `\n${RETRIEVAL_CONTEXT_RULE}` after its rule 4.

Both generate prompts get the rule because single-stage uses `buildGeneratePrompt`, and the default
two-stage path uses `buildGenerateFromAnalysisPrompt`.

### 3h. MODIFY `MemoryKnowledge/.env.example`

Document the four vars in a comment section, e.g.:

```
# KNOWLEDGE_WIKI_RETRIEVAL_ENABLED=true   (default true; false disables)
# KNOWLEDGE_WIKI_RETRIEVAL_TOP_K=3
# KNOWLEDGE_WIKI_RETRIEVAL_MAX_CHARS=12000
# KNOWLEDGE_WIKI_RETRIEVAL_QUERY_TERMS=24
```

### 3i. NOT an ingest change, but a required build prerequisite: `MemoryKnowledge/pnpm-workspace.yaml`

This file exists in the repo as an unfinished placeholder. pnpm 11 refuses to run native build scripts
unless allowlisted, and it reads this file — but only when install runs **without** `--ignore-workspace`.
Fix the file to:

```yaml
allowBuilds:
  better-sqlite3: true
  esbuild: true
  protobufjs: true
```

Without this, `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS` and pnpm-based commands cannot run.
(There is no real parent workspace in this checkout despite a stale `.npmrc` comment.)

## 4. End-to-end data flow (trace one source through a run)

1. User uploads files → they land in `<wiki>/raw/sources/`. `POST /v3/wiki/ingest` →
   `WikiService.ingest` → worker → `WikiSourceManager.ingest` (`manager.ts`).
2. `ingest()` reads config; if enabled, builds the `retrieveContext` closure (queries `searchInternal`,
   reads via `readPageInternal`, formats via `formatRetrievedPages`).
3. `runIngestIncremental` diffs files by sha256; for each changed file it calls
   `extractSource(path, ..., { retrieveContext })` inside the concurrency-limited task.
4. `extractSource` reads the file, splits into ≤28k-char chunks (`chunkText`). Per chunk:
   `retrieveContext(chunkText)` → BM25 search over the wiki (which reflects the **last completed** run)
   → top-3 page ids → read their full markdown → strip frontmatter → format into the
   "Relevant Existing Knowledge" block.
5. That block is injected into the chunk's analysis + generation prompts. The model links to those
   pages instead of duplicating their facts.
6. After the run, `ingest()` rebuilds the FTS index over all pages (delete + re-insert in one
   transaction). Next run's retrieval sees this snapshot.

## 5. Behavior guarantees (correctness by construction)

- **First-ever ingest, empty wiki:** `wiki_fts` empty → `searchInternal` returns `[]` →
  `formatRetrievedPages([])` → `""` → prompt unchanged → ingest succeeds.
- **Retrieval failure anywhere:** manager closure try/catch → `""`; `extractSource` also try/catches
  per chunk → `""`. Extraction is never blocked.
- **Feature disabled** (`KNOWLEDGE_WIKI_RETRIEVAL_ENABLED=false`): `retrieveContext` is `undefined` →
  nothing injected → byte-identical to pre-feature behavior.
- **Backward compatible:** `retrieveContext` is an optional param on `runIngestIncremental` and
  `IngestOptions`; the standalone `ingestSource` wrapper and existing callers are untouched.
- **Never re-implemented search:** ranking is `searchInternal` (existing), page reads are the same
  path `/v3/search` and the agent tools use.

## 6. Verification — how correctness was proven

### A. TypeScript compiles

```
cd MemoryKnowledge
node_modules/.bin/tsc --noEmit
```

Expected: **no errors in any changed file**. The **only** error is pre-existing and unrelated:
`src/middleware/response-envelope.ts(47,9): error TS2322: Type 'Promise<string>' is not assignable to
type 'string'.` (a Hono `bodyCache.text` typing mismatch; it exists on the base branch — do not fix it
as part of this work).

### B. Unit tests (the module's first two test files; both pass: 12/12)

```
LOG_LEVEL=error node_modules/.bin/vitest run
```

(`LOG_LEVEL=error` suppresses the noisy ingest logs.)

**`src/engines/wiki/ingest-v2/retrieval.test.ts`** — pure helpers:
- `buildSearchQuery("the cache cache eviction eviction eviction policy", 3)` → `"eviction cache policy"`
  (stopword `the` dropped, frequency-ranked).
- queryTerms caps output; queryTerms `0` → at least 1 term.
- CJK: `buildSearchQuery("缓存 缓存 管理", 2)` → `"缓存 管理"`.
- All-stopwords input → `""`.
- `formatRetrievedPages`: `[]` → `""`; strips frontmatter; header `### title (relPath)` present;
  multiple pages in order; page without frontmatter works; body longer than `maxChars` gets truncated
  (output shorter than full body, ends with `…`).

**`src/engines/wiki/ingest-v2/extract-source-retrieval.test.ts`** — proves the *per-chunk* behavior
with a mocked `LlmClient` (returns a fixed valid `<<<FILE ...>>>` block; no real LLM):
- Short single-chunk source → `retrieveContext` called **exactly once**, with the full source text; the
  chunk's prompt contains the returned marker.
- Source longer than `SOURCE_CHAR_BUDGET` → `retrieveContext` called **once per chunk**, and its
  arguments deep-equal `chunkText(sourceText, { targetChars: SOURCE_CHAR_BUDGET })` (i.e., the same
  chunks `extractSource` processes); each chunk's prompt contains its own distinct marker. This test
  fails against the old once-per-file implementation, so it is the regression guard.

### C. Install works (needed before B can run)

```
corepack pnpm install          # must NOT pass --ignore-workspace
```

Expected: exit 0, `better-sqlite3` compiles its native binding. Then `corepack pnpm test` and
`corepack pnpm typecheck` work through pnpm too.

### D. Manual end-to-end (NOT run — requires real LLM credentials)

The strongest proof of actual behavior needs an LLM:
1. Start KS with `LLM_MODE=custom` + `LLM_BASE_URL` / `LLM_API_KEY`.
2. Create a wiki; upload `raw/sources/kv-cache.md` (a doc defining what a KV cache is); ingest → ready.
3. Upload `raw/sources/vllm-kv-cache-mgmt.md` (a doc that references KV-cache semantics *without
   restating them*); ingest.
4. Inspect the generated pages: the vLLM page should link `[[KV Cache]]` and carry KV-cache facts not
   literally present in its own source.
5. Re-run step 3 with `KNOWLEDGE_WIKI_RETRIEVAL_ENABLED=false` and compare — the delta shows the
   augmentation's effect.

### E. What "correct" means, summarized

Correct = (1) the injected block is derived from *real existing page content* via the existing search
path; (2) it's per-chunk so long-file chunks get targeted context; (3) it never changes behavior when
the feature is off, on an empty wiki, or on retrieval failure; (4) the whole module still typechecks
and every test passes; (5) the only tsc error is a pre-existing one you didn't cause.

## 7. Gotchas for the recreator

- **Do not** pass `--ignore-workspace` to pnpm — it makes pnpm skip `pnpm-workspace.yaml`, which
  re-breaks install.
- If install is broken and you can't fix it, run verification directly:
  `node_modules/.bin/tsc --noEmit`, `node_modules/.bin/vitest run` (binaries exist once deps are
  installed even if the build-script approval failed; the retrieval unit tests don't import
  `better-sqlite3`).
- The `一-鿿` regex ranges may be written literally; both are valid.
- `SOURCE_CHAR_BUDGET` must be exported (tests read it).
- Two commits exist on the fork's `feat/server_team`: `d00ef36` (base feature) and `f03d42f`
  (per-chunk refinement). Recreate the **final** state; don't reproduce the intermediate once-per-file
  form.
