# ZH → EN Migration Plan (delegable to a cheap LLM in a coding harness)

> **Purpose**: Translate the human-language Chinese in this fork to English, so a non-Chinese reader can maintain it and the product can present English.
> **Scope**: This fork only. Never commit to / push to the upstream Tencent repo. Work on the existing branch (`feat/server_team`).
> **Executor**: any coding agent (Claude Code, Gemini CLI, aider, opencode, …). The plan is harness-agnostic. Follow it top to bottom. Do not skip steps.
> **Master rule**: translate *natural language* only — never code. When in doubt about whether something is code, treat it as code and leave it. If you cannot translate a passage confidently, **leave the Chinese in place and flag it** in the commit message. Guessing wrongly is worse than leaving Chinese.

---

## 0. Non-goals (do NOT do these while translating)

- No refactoring, no "improvements", no bug fixes, no reformatting.
- No changes to behavior, schema, DB, API contracts, or IDs.
- Do not translate anything on the **Protected list** (§3).
- Do not translate Chinese that is **functional input data** (§4.2) — e.g. tokenizer test fixtures.
- Do not hand-edit generated files (§3 item 4).

---

## 1. Setup

```bash
cd <repo>                        # C:\Users\yonik\TencentDB-Agent-Memory
git status                       # confirm clean working tree except your pre-existing edits; branch = feat/server_team
git checkout -b chore/zh-to-en    # work on this branch
```

Baseline checks (each must pass *before* you change anything, so regressions are attributable to you):

| Package | Command (run from that package dir) |
|---|---|
| MemoryProxy | `npm run typecheck && npm test` |
| MemoryCore | `npm test` |
| MemoryKnowledge | `npm run typecheck && npm test` |
| MemoryPanel | `npm run typecheck && npm test` |

Run only unit tests (`vitest`). **Skip** the `test:standalone:*` / `test:*:e2e` scripts — they need live infra.

Write down the pass/fail baseline. If something already fails, note it; you are not required to fix pre-existing failures, only to not *add* new ones.

---

## 2. Global translation rules (apply to EVERY file)

Translate the **Chinese text** in comments, docstrings, template literals, string constants, UI strings, and docs. Preserve everything around it exactly.

**R1 – Structure must survive byte-for-byte outside translated spans.** Same indentation, same quote style (`"` vs `` ` `` vs `'`), same surrounding punctuation, same line count when feasible. Do not rewrap lines, do not merge/split lines, do not re-indent.

**R2 – Never translate identifiers / code tokens.** Variable names, function/class names, `const X = …` keys, object property names, enum values, `type:` values, JSON field names, file names, folder names, package names, import paths, env var names, CLI flags, URLs, `@param`/`@returns`/`@deprecated` **tag names** (translate only the *description* that follows a tag), `[DELETED]`, `created/updated/summary/heat` style metadata keys.

**R3 – Template literals (backticks).** Only replace the human-language text *inside* the string. Keep every `${...}` interpolation, every escape (`\n`, `\``, `\x`), every code fence, and Markdown markers (`**bold**`, `` `code` ``, `#` headings, `-` lists). A Chinese comment *inside* a template literal is still text — translate it; a `${var}` inside it is code — keep it.

**R4 – Comments.** Keep the marker and its position (`//`, `/*`, `*` continuation, `/** */`, `#`). Translate the prose. For JSDoc: keep tag names, translate descriptions. For decorative dividers like `──── 情境切分 ────`, translate only the inner word, keep the divider characters.

**R5 – Markdown / docs.** Translate prose; keep all markup, links, code fences, tables, headings' hash signs. Do not translate literal code/filenames inside inline code spans. Do not translate `_CN`/`.zh-CN.md`/`zh-CN` language tags or the tokens `中文:` used as a cross-reference label (translate the label's *meaning* only if the surrounding file is English-first and the pointer remains valid).

**R6 – Keep behavior-critical semantics.** If a string is *matched against at runtime* (`.includes`, `.startsWith`, regex `.test`, `===`), translating it can break the feature — see §4.1 lockstep rule.

**R7 – Same text, same translation.** Use one consistent English rendering for a repeated Chinese phrase (e.g. a term appearing in many files). Before writing a new file, grep for prior translations of the key phrases.

**R8 – English quality bar.** Idiomatic, professional English for a developer-tool codebase. Keep the tone the original had (terse comment → terse comment). Do not add fluff. For product/UI text, match the voice already present in `MemoryPanel/web/src/i18n/en-US.ts`.

---

## 3. Protected list — NEVER translate, edit, or delete

| Path / pattern | Reason |
|---|---|
| `MemoryPanel/web/src/i18n/zh-CN.ts` | It is the Chinese *locale dictionary* — Chinese is its content, not a bug. The UI is bilingual; do not touch it. |
| `**/*_CN.md`, `**/*.zh-CN.md`, `**/*.zh_CN.md`, `AGENT_GUIDE.*.zh-CN.md` | Official Chinese doc twins. If you want them gone, **delete the file** (that is a clean action) — never "translate the twin"; it duplicates the English file. |
| `MemoryCore/src/gateway/generated/**` (incl. `schemas.ts`), any `**/generated/**` | Auto-generated (Kubb). Hand edits get overwritten. See §4.3 for the correct regeneration path. |
| `MemoryKnowledge/src/engines/wiki/tokenize.ts` and any file whose *function* is CJK/Chinese language processing | Chinese here is the subject of the code (CJK regexes, stop words, bigram logic), not prose to translate. |
| Chinese *strings used as test fixtures* in wiki/ingest tests (e.g. `buildSearchQuery("缓存 缓存 管理")`) | They test tokenization of actual Chinese input. Removing them removes coverage. |
| `MemoryCore/kubb.config.ts`, `pnpm-lock.yaml`, lock files, `package.json` version numbers, CI configs | Not prose. |
| `*.local`, `.env*` values, secrets | Never touch. |

---

## 4. Three special classes (read fully before starting any tier)

### 4.1 Lockstep class — user-visible confirm flow in MemoryProxy (highest risk)

A session Q&A flow shows Chinese **buttons/options** to the end user, and code **parses the user's reply** by matching those exact Chinese strings. Translating the labels but not the matchers (or vice versa) silently breaks the flow.

Files involved (all under `MemoryProxy/src`):
- Button/label constants: `session/form.ts`, `session/{claude-code,codex,opencode,dsh,workbuddy,codebuddy}/form.ts` — `ASSET_CONFIRM_YES`, `ASSET_CONFIRM_NO`, `SKIP_LABEL`, `MORE_LABEL`, `NO_MORE_LABEL`, `CODEX_MORE_LABEL`, etc.
- Reply matchers: `session/claude-code/extractor.ts`, `session/codebuddy/extractor.ts`, `session/workbuddy/extractor.ts`, `session/codex/index.ts`, `session/store.ts` (the `question.includes("关联")` / `content.includes("本次不关联")` checks).
- Confirmation copy returned to the user after the flow: `anthropicHandler.ts`, `codexHandler.ts`, `handler.ts` (e.g. `"✅ 已跳过团队资产关联"`, `"- **Task**: 未关联"`).
- Note punctuation drift between agents (half-width `是,关联团队资产` in `dsh/form.ts` vs full-width `是，关联团队资产` elsewhere) — translations must stay internally consistent *per file* and still be matched by that file's extractor.

**Lockstep rule**: for each agent flow, translate in ONE coordinated edit: label constant → the matcher that consumes it → any confirmation string it triggers → the copy rendered to the user. Then run `MemoryProxy` tests.

**Fork decision (bilingual warning):** these matchers exist to detect a Chinese-speaking user's intent. In an English-only fork, translate the matchers to English keyword equivalents (`关联`/`资产` → `associate`/`asset`/`link`, etc.). If you intend to keep serving Chinese users too, keep the Chinese alternates *in addition to* English (e.g. `question.includes("关联") || /associat|asset|link/i.test(question)`). Pick one policy and apply it everywhere in this class; record which in the commit message.

### 4.2 Functional-data Chinese — do NOT translate (keep as data)

- CJK tokenizer test inputs and stop-word fixtures.
- Any literal Chinese that the code is *expected to produce or match* as domain data rather than show as UI copy. When unsure whether a string is UI copy vs matched data, trace its consumers first (grep for the exact string) before touching it.

### 4.3 Prompt corpus — translate the prose, keep the contract

The LLM prompts deliberately instruct the model to **write output in the language of the user's message / dominant language of the memories** (they say things like *输出语言：…使用与用户消息相同的语言*). This is a **feature**, not Chinese to purge.

- Translate the *instruction prose* and *worked examples* to English, but **preserve the language-following instruction** in English (e.g. “Output language: write `scene_name` and memory `content` in the same language as the user's messages; JSON field names, enum values, ISO timestamps stay English.”).
- Keep JSON scaffolding, enum values (`"persona"` / `"episodic"` / `"instruction"`), priority numbers, `[DELETED]`, file names, and metadata keys exactly as they are (they are code-ish tokens inside the prompts).
- The offload prompt files exist **twice**: `MemoryCore/src/offload_server/prompts/{l1,l15,l2}-prompt.ts` and `MemoryCore/src/offload/local-llm/prompts/{l1,l15,l2}-prompt.ts`. Diff the pair before editing; translate both copies to the same English. They must stay in sync.
- Tool-description Chinese (see Tier 2 file list) is model-facing; translate it to idiomatic English — this is what the model reads when deciding to call a tool.

---

## 5. Tiers — do them in order; each tier ends with a green check + commit

### Tier 0 — setup
Commands in §1. Create a fresh branch `chore/zh-to-en`. Record baseline test results. **Commit**: `chore: baseline for zh→en migration (no changes)` (empty commit ok if tree dirty with your pre-existing edits — commit only what you change from now on).

### Tier 1 — Lockstep confirm flow (MemoryProxy)
Apply §4.1 to all seven `form.ts` files, all extractors, `session/codex/index.ts`, `session/store.ts`, and the three handlers' confirmation copy. Find every consumer of `ASSET_CONFIRM_*`, `SKIP_LABEL`, `MORE_LABEL`, `NO_MORE_LABEL` first:
```bash
cd MemoryProxy
rg -n 'ASSET_CONFIRM_(YES|NO)|SKIP_LABEL|MORE_LABEL|NO_MORE_LABEL|CODEX_MORE_LABEL'
```
✓ Done when: every end-user-visible Chinese string in a `MemoryProxy/src/session/**` or `MemoryProxy/src/*Handler.ts` / `handler.ts` flow is English **and** its matcher still finds it (run `npm run typecheck && npm test`).
Commit: `feat(i18n): english asset-association confirm flow (labels+matchers+copy in lockstep)`.

### Tier 2 — Prompt corpus + tool descriptions
Apply §4.3. Priority files:

**Core prompts** (`MemoryCore/src/core/prompts/`): `scene-extraction.ts`, `l1-extraction.ts`, `persona-generation.ts`, `l1-dedup.ts`, `skill/prompts/skill-review-prompt.ts`, and any other file in that folder that contains Chinese.
**Offload prompts** (both copies): `MemoryCore/src/offload_server/prompts/*` **and** `MemoryCore/src/offload/local-llm/prompts/*`.
**Knowledge prompts**: `MemoryKnowledge/src/engines/wiki/ingest-v2/prompts.ts`, `.../ingest-v2/template.ts`, `.../ingest-v2/index.ts` (Chinese prose only).
**Tool descriptions / injected content (model-facing)**: 
`MemoryPanel/src/panel/http/routes/meta/default-skills.ts`
`MemoryProxy/src/injection/injectors/{knowledge-tools,skill-tools,tdai-tools,tdai-profile-memory}-injector.ts`
`MemoryProxy/src/injection/agents/{codebuddy,workbuddy}/constants.ts`
`agents/asset-import.ts`
`MemoryKnowledge/src/routes/tools.ts`
`MemoryKnowledge/src/engines/wiki/manager.ts`

✓ Done when: no Chinese remains in those files except allowed tokens (§4.3). Run `MemoryCore npm test` + `MemoryKnowledge npm test` + `MemoryProxy npm test`. Check offload pairs are identical English in both copies:
```bash
diff <(sed 's/[A-Za-z]*//g' MemoryCore/src/offload_server/prompts/l1-prompt.ts) \
     <(sed 's/[A-Za-z]*//g' MemoryCore/src/offload/local-llm/prompts/l1-prompt.ts)
# only Chinese/whitespace should be equal already; the English should match too
```
Commit: `feat(i18n): english prompt corpus + tool descriptions (language-contract preserved)`.

### Tier 3 — Console / CLI / shell text
- `MemoryCore/scripts/**/*.ts` user-facing `console.log/error` messages and prompts (not internal debug `console.log`s if they only the author reads — translate those too if trivial). Notable: `read-local-memory/`, `export-tencent-vdb/`, `import-opik-to-memory-core/`, `migrate-sqlite-to-tcvdb/`, `verify-*.ts`, `cleanup-*.ts`, `seed-*`.
- Shell scripts: every `.sh` with Chinese (`echo` copy + `#` comments). Biggest: `MemoryKnowledge/start.sh`; also `MemoryPanel/scripts/*.sh`, `deploy/**/*.sh`. Keep step markers like `[1/5]`; keep `\n`/color codes intact.
- `MemoryPanel/scripts/generate-meta-openapi.ts` and other generator scripts' Chinese prose.

✓ Done when: a non-Chinese user can read all script output and shell comments. No tests target scripts, so ✓ = grep shows no Han in the edited files. Commit per script group.
Commit: `feat(i18n): english cli + shell output`.

### Tier 4 — Code comments (the bulk) + docs
- Every `.ts/.tsx/.py/.js` comment still containing Chinese anywhere in the repo, **excluding** Protected list. Process directory by directory, file by file, applying R4. Do not let context overrun — work in small batches (≤ ~20 files per batch), commit per directory.
- `sdk/**` comments and the English `README.md` files (remove only residual Chinese prose; do not touch the `中文:` cross-reference labels unless the target `_CN.md` is deleted).
- `CHANGELOG.md` Chinese entries → translate; keep chronological structure.

✓ Done when: Han-leak detector (§6) reports zero in every non-protected path. Commit: `feat(i18n): english code comments + docs`.

### Tier 5 — Panel leftovers, locale parity, regeneration
- **Hard-coded Chinese in panel components** (~150 lines outside `i18n/`): `MemoryPanel/web/src/pages/**/*.tsx` (Workbench/Task/Skills/Wiki/BoardView etc.). Prefer routing through i18n: if the text matches an existing key value, use `t('key')`; otherwise add a **new key to both `zh-CN.ts` (original Chinese) and `en-US.ts` (English)** and use `t('key')`. Fall back to a plain English literal only when there is no i18n mechanism in that component.
- **Locale parity**: find zh keys missing from en-US and write English for each:
  ```bash
  comm -23 <(rg -o "'[^']*':" MemoryPanel/web/src/i18n/zh-CN.ts | sort) \
           <(rg -o "'[^']*':" MemoryPanel/web/src/i18n/en-US.ts | sort)
  ```
- **Regenerate, don't hand-edit** `MemoryCore/src/gateway/generated/schemas.ts` (Kubb). Trace the Chinese descriptions to their source of truth (search non-generated files for one of the description strings), translate **there**, then run the generator from `MemoryCore` (`npx kubb generate`). If you cannot locate the generator input, **do not edit the generated file** — open a flag in the final summary instead.
- Delete (or leave untracked) the `_CN.md` twins if the fork is English-only, and remove stale `中文: [..]` pointer lines in the English docs.

✓ Done when: `MemoryPanel npm run typecheck && npm test` passes, en-US has no missing keys, regenerated diff adds no Chinese. Commit: `feat(i18n): panel strings + locale parity + regenerated schemas`.

---

## 6. Han-leak detector (run after every tier)

Expectation: the count should drop monotonically per tier and finally equal the protected/functional set only.

```bash
# Files still containing Chinese, excluding protected paths:
rg --pcre2 -l '\p{Han}' \
   -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/build/**' \
   -g '!**/generated/**' -g '!**/i18n/zh-CN.ts' \
   -g '!**/*_CN.md' -g '!**/*.zh-CN.md' -g '!**/*.zh_CN.md' \
   | tee /tmp/remaining-han.txt | wc -l
```

Legitimate survivors (do not "fix" these): `MemoryKnowledge/src/engines/wiki/tokenize.ts`, wiki ingest test fixtures, CJK stop-word lists, anything on the Protected list. Everything else must be zero at the end.

Record the count after each tier in the tier commit message so progress is auditable.

---

## 7. Operating procedure for the harness agent (cheap models especially)

1. **Batch, don't blast.** Edit files in small groups (≤20 files). Large single-shot rewrites drift and corrupt code structure. Between groups, run the detector + typecheck.
2. **Per-file self-check before saving**, against R1–R8: (a) diff shows only intended lines; (b) no identifier/quote/indentation changed; (c) no `${...}` altered; (d) nothing on the Protected list touched; (e) strings that are matched at runtime were translated in lockstep.
3. **Prefer the translation that already exists.** Grep for a phrase's previous English rendering before translating it again, so the codebase stays consistent.
4. **When context runs low, stop and commit.** Never continue past a commit boundary to save tokens; commits are the safety net. A partial tier is fine if its commit message says exactly what remains.
5. **Never guess on the Protected list or generated files.** Flag instead.
6. Do not run `git push`. Commit locally only. Optionally tag the final state.

---

## 8. Failure modes to watch for

| Symptom | Likely cause | Fix |
|---|---|---|
| `tsc`/`vitest` errors after a file edit | Translated an identifier/`${...}`/string structure | Revert that file, re-read §2 |
| Confirm-flow test fails after Tier 1 | Label and matcher diverged | Same-language label+regex, see §4.1 |
| New runtime Chinese detected later | Matcher-only change left a Chinese literal in logic | Keep matchers in lockstep; run `rg '\p{Han}'` on the feature dir |
| `schemas.ts` Chinese reappears | Someone hand-edited generated file | Revert; fix generator input (§4.3) |
| Wiki ingest test fails | Tokenizer fixture Chinese removed | Restore fixture; it is functional data (§4.2) |
| Detector count not dropping | Working on Protected list or `_CN.md` twins | Check §3 |

---

## 9. Appendix — reference inventory (measured 2026-09-04, branch feat/server_team)

- Whole repo: 670 files w/ Chinese; ~26,000 lines; ~308,000 Han chars.
- Code `.ts/.tsx`: 17,545 Han-lines, of which **~13,554 (77%) are comments** (Tier 4). Non-comment ≈ 3,990 lines = prompts, tool text, logs, UI, and the lockstep flow (Tiers 1–3, 5).
- Docs `.md`: 5,355 Han-lines, but English files are already ≥99% English; bulk of that is `_CN.md` twins (delete, don't translate) + `CHANGELOG.md`.
- Biggest prompt files: `scene-extraction.ts` 293, `l1-extraction.ts` 232, `persona-generation.ts` 147, `l1-dedup.ts` 87, offload `l2-prompt.ts` ~38 each copy, wiki-ingest `prompts.ts` 25.
- Top non-comment Chinese by file: `i18n/zh-CN.ts` 1209 (protected), `default-skills.ts` 120, schemas.ts 208 (generated), scripts `read-local-memory` 79, `export-tencent-vdb` 75, `import-opik` 60, `migrate-sqlite` 55.
- Shell: ~26 `.sh`, 1,071 Han-lines (comments + `echo` copy) — Tier 3.
- Proxy lockstep cluster file list: see §4.1.
- Cost guidance: raw LLM/MT tokens are negligible (<$15 worst case even at retail). Human-value risk concentrates in Tier 1 (lockstep) and Tier 2 (prompt contract). Tiers 3–4 are mechanical. Estimated split of effort by tier: 1≈15%, 2≈20%, 3≈10%, 4≈45%, 5≈10%.

**Final definition of done**: Han-leak detector = 0 outside the documented survivor set; all package unit tests + typechecks green; git log shows one commit per tier with detector counts; no pushes; everything still on `feat/server_team`/`chore/zh-to-en`.
