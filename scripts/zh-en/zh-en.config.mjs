// scripts/zh-en/zh-en.config.mjs
// File-category contract for the ZH->EN effort. Single source of truth read by
// leak-count.mjs and (via the workflow) by translation agents.
//
// Buckets:
//   protected   - Chinese stays by design (locale dict, generated, CJK-functional,
//                 doc twins that get DELETED in the fork, user-decided CN tokens).
//   scrub       - committed one-off translation junk. Never translate; delete later.
//                 These are excluded so they stop inflating every census number.
//   binary      - non-text assets, excluded by extension (see binaryExts).
//   everything else with Han  ->  "translatable"  ->  worklist.json
//
// Globs support `**` (any depth) and `*` (within one path segment). A pattern
// without `/` matches at any depth. Align with ZH_EN_TRANSLATION_PLAN.md §3.

export const protectedGlobs = [
  // Locale dictionary - Chinese is its content.
  '**/zh-CN.ts',
  '**/zh-CN.*',
  // Auto-generated (Kubb and friends). Hand edits get overwritten.
  '**/generated/**',
  '**/gateway/generated/**',
  '**/*.generated.*',
  // Official Chinese doc twins -> DELETE in the fork, never "translate" them.
  '**/*_CN.md',
  '**/*.zh-CN.md',
  '**/*.zh_CN.md',
  'AGENT_GUIDE*.zh-CN.md',
  // CJK tokenizer + its fixtures - Chinese is the subject of the code (plan §4.2).
  'MemoryKnowledge/src/engines/wiki/tokenize.ts',
  'MemoryKnowledge/src/engines/wiki/**/*.test.ts',
  'MemoryKnowledge/src/engines/wiki/**/*.spec.ts',
  'MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts', // docstring example must show CJK -> CJK slug output
  'MemoryKnowledge/docs/retrieval-augmented-ingestion-reimplementation.md', // code-fence CJK literals/stop-words/ranges
  // Functional Chinese tokens, user decision 2026-09-04 (EN mirror added alongside).
  'MemoryCore/src/utils/sanitize.ts',
  'MemoryCore/src/core/skill/skill-extractor.ts',
  // Build / lock / CI metadata.
  '**/kubb.config.ts',
  '**/*lock*.json',
  '**/pnpm-lock.yaml',
  // Asset graphics (SVG may embed text labels; keep as-is).
  '**/*.svg',
  // Bilingual asset-confirm matchers (plan §4.1 fork decision): Chinese alternates
  // kept so the flow still serves Chinese-speaking users - runtime regexes/.includes().
  'MemoryProxy/src/session/store.ts',
  'MemoryProxy/src/session/extractor.ts',
  'MemoryProxy/src/session/claude-code/extractor.ts',
  'MemoryProxy/src/session/codebuddy/extractor.ts',
  // QA smoke script: Chinese agent name (开发大师) is a runtime default/test value.
  'MemoryProxy/scripts/qa/codex-init.sh',
  // Fork's own operating plan: Chinese matcher examples are intentional (§4.1 documentation).
  'ZH_EN_TRANSLATION_PLAN.md',
];

// Committed scratch from earlier passes. `git rm` each and it stops showing here.
export const scrubGlobs = [
  '**/src_backup/**',
  '**/scratch/**',
  '**/chinese_lines.json',
  '**/files_with_chinese.json',
  'chinese.txt',
  '**/c_dump.txt',
  '**/work_prompt_replacement.txt',
  // One-off batch-translate helpers from earlier passes (Google-translate CLI glue etc).
  '**/translate*.py',
  '**/test_translate.*',
  '**/fix_extraction.py',
  '**/replace_lines*.py',
  '**/force_replace.py',
  '**/fix_handlers.js',
  '**/server_fix*.js',
  '**/script.js',
  '**/chinese_batch1.*',
  '**/chinese_gateway.txt',
  '**/server_chinese.*',
];

// Files matching these extensions are treated as non-text and ignored entirely.
export const binaryExts = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'mov', 'mp4', 'webm', 'mkv', 'avi', 'mp3', 'wav',
  'zip', 'gz', 'tar', '7z', 'rar', 'woff', 'woff2', 'ttf', 'eot', 'otf',
  'pdf', 'map', 'sqlite', 'db', 'node', 'class', 'jar', 'pyc', 'so', 'dll',
];
