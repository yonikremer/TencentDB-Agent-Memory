// scripts/zh-en/zh-en-translate.workflow.js
// Dynamic ZH->EN translation worker for the fork. Run via the Workflow tool with:
//   { scriptPath, args }
// args:
//   { repoRoot: "C:/Users/yonik/TencentDB-Agent-Memory" }              (always)
//   TARGET MODE (bounded, one wave, no scanning):
//     targetClusters: [ { id, files: ["MemoryProxy/src/x.ts", ...] }, ... ]
//   DYNAMIC MODE (scan-until-dry over the whole translatable census):
//     all: true, perRound: 5, maxRounds: 200, order: "small" | "large"
//
// How it stays cheap: the orchestrator never reads Chinese content. Each cluster
// is one fresh worker context that reads only its own files + the plan doc, edits,
// and returns before/after Han counts. The disk (Han removed) is the done-ledger;
// the census is re-scanned between rounds, so finished files fall out naturally.
//
// Plain JavaScript only (Workflow restriction): no fs, no Date. Everything the
// workers need arrives via args or is fetched by the workers themselves.

export const meta = {
  name: 'zh-en-translate',
  description: 'Translate remaining repo Chinese to English: per-cluster fresh workers, dynamic scan-until-dry',
  phases: [
    { title: 'Scan', detail: 'census finds remaining translatable clusters' },
    { title: 'Translate', detail: 'one fresh worker per cluster' },
    { title: 'Verify', detail: 're-census + check attempted files' },
  ],
};

// ---- inputs ---------------------------------------------------------------
const WIN = 'C:/Users/yonik/TencentDB-Agent-Memory';
const repoWin = (args && args.repoRoot) || WIN;
const repoBash = repoWin.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, '/$1/');
const planPath = `${repoWin.replace(/\//g, '\\')}\\ZH_EN_TRANSLATION_PLAN.md`;

// ---- schemas --------------------------------------------------------------
const SCAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    done: { type: 'boolean' },
    totalRemainingHan: { type: 'integer' },
    take: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          han: { type: 'integer' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'files'],
      },
    },
  },
  required: ['done', 'totalRemainingHan', 'take'],
};

const TRANS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          hanBefore: { type: 'integer' },
          hanAfter: { type: 'integer' },
          status: { type: 'string', enum: ['translated', 'skipped'] },
          skipReason: { type: 'string' },
        },
        required: ['path', 'hanBefore', 'hanAfter', 'status'],
      },
    },
  },
  required: ['results'],
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    translatableFiles: { type: 'integer' },
    translatableHan: { type: 'integer' },
    protectedFiles: { type: 'integer' },
    scrubFiles: { type: 'integer' },
    attemptedStillHan: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' }, han: { type: 'integer' } },
        required: ['path', 'han'],
      },
    },
  },
  required: ['translatableFiles', 'translatableHan', 'protectedFiles', 'scrubFiles', 'attemptedStillHan'],
};

// ---- prompts --------------------------------------------------------------
function scanPrompt(perRound, claimedIds, order, prefixFilter) {
  const claimedJson = claimedIds.length ? JSON.stringify(claimedIds) : 'none';
  const pick = order === 'large'
    ? `the ${perRound} LARGEST unclaimed clusters (front of the array)`
    : `the ${perRound} SMALLEST unclaimed clusters (end of the array)`;
  const scope = prefixFilter
    ? `IMPORTANT SCOPE: only consider files under the path prefix "${prefixFilter}". Filter both translatable and clusters to paths starting with "${prefixFilter}/". If NO unclaimed clusters remain under this prefix, set done=true.`
    : 'Consider the whole repo.';
  return [
    `You are the SCANNER for a ZH->EN translation run in the repo at ${repoWin}.`,
    `1) cd to repo root if needed: cd ${repoBash}`,
    `2) Run the census and capture its one-line JSON:`,
    `   node scripts/zh-en/leak-count.mjs --json --top 200`,
    `   Fields: summary.translatableFiles / summary.translatableHan (the whole remaining corpus);`,
    `   translatable = [{path,han}] of every still-translatable file;`,
    `   clusters = [{id,han,files:[...]}] where files whose Chinese is byte-identical are grouped.`,
    `   NEVER split a cluster: its files must be translated together to the same English.`,
    scope,
    `3) Claim whole clusters only. Skip every cluster whose id is in CLAIMED below.`,
    `4) Return take[] = ${pick}, each {id, han, files}.`,
    `5) done=true ONLY if no unclaimed clusters remain in scope. totalRemainingHan = summary.translatableHan.`,
    `CLAIMED (excluded): ${claimedJson}`,
  ].join('\n');
}

function translatePrompt(cluster, lowRisk) {
  const files = cluster.files;
  const L = [];
  L.push(`You are a translation WORKER in the repo at ${repoWin} (bash: ${repoBash}).`);
  if (lowRisk) {
    // Lean prompt for pure-comment batches: no plan-doc read (the main cost saver).
    L.push('Translate ONLY human-readable Chinese to English in the listed files.');
  } else {
    L.push(`READ THE RULES FIRST: open ${planPath} and follow §2 (rules R1-R8), §3 protected list, §4.2 (functional-data Chinese must NOT be translated), §4.3 (prompt contract - keep the "write in the user's language" instruction), §5 (tier rules: hard-coded UI text in .tsx - prefer an existing i18n key via t('key'); if none exists, use a plain English literal; do NOT add new i18n keys or rewire components).`);
    L.push('Translate the human-language Chinese in the listed files to English, per those rules.');
  }
  L.push('Files (ONE batch - translate each; keep copies of identical Chinese identical):');
  for (const f of files) L.push(`  - ${f}`);
  L.push('', `cd to repo root if needed: cd ${repoBash}`);
  L.push('Before editing each file, note its Han count:');
  L.push('   node scripts/zh-en/leak-count.mjs --file "<relpath>"   -> "<relpath>\\t<han>"');
  L.push('Find the exact Chinese text efficiently - DO NOT read whole files just to locate Chinese:');
  L.push('   node scripts/zh-en/leak-count.mjs --lines "<relpath>"  -> "lineno\\t<full line text>" for every line that has Han');
  L.push('Translate by Editing those lines directly (you already have their exact text). Read a short window (Read tool, offset/limit) ONLY when you need surrounding context - e.g. a multi-line JSDoc/comment block or to confirm structure. Small or densely-Chinese files may be read whole.');
  L.push('');
  L.push('Translate ONLY human-readable Chinese: comments, docstrings, JSDoc descriptions (keep tag names), log/console copy, user-facing copy.');
  L.push('NEVER translate: identifiers, variable/function/class/type names, object keys, enum/type values, JSON field names, import paths, file names, URLs, env var names, CLI flags, format specifiers, \\${...} interpolation, or any Chinese string the code matches at runtime (.includes/.startsWith/.test/===/indexOf). If runtime-matched Chinese is all a file has, LEAVE it and set status=skipped.');
  L.push('');
  L.push('Preserve structure byte-for-byte outside the text you translate: same indent, quote style, and line structure. In template literals keep every \\${...} and every escape sequence. Keep comment markers (//, /*, *, /** */, #) and decorative divider characters - translate only the inner words.');
  L.push('Same Chinese phrase -> the same English you use elsewhere in these files (grep for a prior translation before inventing one). Idiomatic developer-tool English, keep the original tone and brevity.');
  L.push('');
  L.push(`Edit with the Edit tool (absolute paths required). Repo root: ${repoWin.replace(/\//g, '\\')}. Each file's absolute path = that root + '\\' + the file's relative path with backslashes. Do NOT touch any file outside this batch.`);
  L.push('After editing: re-run leak-count --file for every file to get hanAfter, then RE-READ each edited file and confirm only intended text changed - structure/backticks/quotes balanced, no identifier or \\${...} altered.');
  L.push('When unsure whether something is code, treat it as code and LEAVE the Chinese; if a file cannot be safely translated, status=skipped with a short skipReason. Never guess.');
  L.push('Return results[]. hanAfter should be 0 for fully translated files.');
  return L.join('\n');
}

function verifyPrompt(attemptedPaths) {
  return [
    `You are the VERIFIER for a ZH->EN translation run in the repo at ${repoWin}.`,
    `cd to repo root: cd ${repoBash}`,
    `1) Re-run the census and read the summary: node scripts/zh-en/leak-count.mjs --json --top 300`,
    `   Return translatableFiles/translatableHan/protectedFiles/scrubFiles from summary.`,
    `2) The following files were just translated. Check each one's Han count (node scripts/zh-en/leak-count.mjs --file "<path>") and report any that still contain Han in attemptedStillHan as {path, han}.`,
    `Attempted files: ${attemptedPaths.length ? attemptedPaths.join(', ') : '(none)'}`,
    `Return the numbers.`,
  ].join('\n');
}

// ---- work ------------------------------------------------------------------
async function translateCluster(cluster, idx) {
  const label = cluster.id ? `tr:${String(cluster.id).slice(0, 8)}` : `tr:${idx}`;
  const opts = { schema: TRANS_SCHEMA, phase: 'Translate', label };
  if (translateModel) opts.model = translateModel; // optional quality override for full runs
  const res = await agent(translatePrompt(cluster, lowRisk), opts);
  return { cluster, res };
}

function finalSummary(verify, stats) {
  return {
    mode: stats.mode,
    rounds: stats.rounds,
    clustersDispatched: stats.clustersDispatched,
    filesAttempted: stats.filesAttempted,
    resultCount: stats.resultsCount,
    skipped: stats.skipped,
    censusAfter: {
      translatableFiles: verify.translatableFiles,
      translatableHan: verify.translatableHan,
      protectedFiles: verify.protectedFiles,
      scrubFiles: verify.scrubFiles,
    },
    stillHanOnAttempted: verify.attemptedStillHan,
  };
}

const TARGET = (args && args.targetClusters) || [];
const DYNAMIC = !!(args && args.all);
const translateModel = (args && args.translateModel) || undefined;
const lowRisk = !!(args && args.lowRisk); // lean prompt, no plan re-read (pure-comment batches)
const prefixFilter = (args && args.prefixFilter) || null; // dynamic mode: restrict scan to this path prefix
const perRound = (args && args.perRound) || 5;
const maxRounds = (args && args.maxRounds) || (DYNAMIC ? 300 : 1);
const order = (args && args.order) || 'small';
const maxRetries = 2;

const stats = {
  mode: TARGET.length ? 'target' : (DYNAMIC ? 'dynamic' : 'dynamic'),
  rounds: 0,
  clustersDispatched: 0,
  filesAttempted: [],
  resultsCount: 0,
  skipped: [],
};

const claimed = new Set();
const attempts = {}; // clusterId -> retry count (only for failed waves)

if (TARGET.length) {
  // TARGET MODE - one bounded wave over explicitly-listed clusters.
  log(`target mode: translating ${TARGET.length} cluster(s): ${TARGET.map((c) => c.files.join('+')).join(' | ')}`);
  const wave = await parallel(TARGET.map((c, i) => () => translateCluster(c, i)));
  for (const w of wave) {
    if (!w) { stats.skipped.push({ id: 'target', reason: 'worker failed' }); continue; }
    stats.clustersDispatched++;
    for (const r of w.res ? (w.res.results || []) : []) {
      stats.resultsCount++;
      stats.filesAttempted.push(r.path);
      if (r.status === 'skipped') stats.skipped.push({ path: r.path, reason: r.skipReason || 'skipped' });
      if (r.hanAfter > 0 && r.status === 'translated') log(`  partial: ${r.path} before=${r.hanBefore} after=${r.hanAfter}`);
    }
  }
  log(`target wave done: ${stats.clustersDispatched} cluster(s), ${stats.resultsCount} file result(s).`);
} else {
  // DYNAMIC MODE - scan -> translate wave -> rescan until dry.
  log(`dynamic mode: scan-until-dry, ${perRound} clusters/round, order=${order}`);
  let done = false;
  while (!done && stats.rounds < maxRounds) {
    stats.rounds++;
    phase('Scan');
    const scan = await agent(scanPrompt(perRound, [...claimed], order, prefixFilter), { schema: SCAN_SCHEMA, phase: 'Scan', label: `scan:${stats.rounds}` });
    if (!scan) { log(`round ${stats.rounds}: scanner returned nothing - stopping`); break; }
    const take = (scan.take || []).filter((c) => !claimed.has(c.id));
    log(`round ${stats.rounds}: remaining translatable Han=${scan.totalRemainingHan}; claiming ${take.length} cluster(s)`);
    if (take.length === 0) { done = true; break; }
    if (scan.done && take.length === 0) break;

    phase('Translate');
    const wave = await parallel(take.map((c, i) => () => translateCluster(c, i)));
    for (let i = 0; i < wave.length; i++) {
      const w = wave[i];
      const c = take[i];
      if (!w) {
        attempts[c.id] = (attempts[c.id] || 0) + 1;
        if (attempts[c.id] >= maxRetries) { claimed.add(c.id); stats.skipped.push({ id: c.id, reason: 'worker failed after retries' }); }
        continue;
      }
      stats.clustersDispatched++;
      claimed.add(c.id);
      for (const r of (w.res && w.res.results) || []) {
        stats.resultsCount++;
        stats.filesAttempted.push(r.path);
        if (r.status === 'skipped') stats.skipped.push({ path: r.path, reason: r.skipReason || 'skipped' });
        if (r.hanAfter > 0) log(`  leftover Han in ${r.path}: before=${r.hanBefore} after=${r.hanAfter}`);
      }
    }
    if (scan.done) done = true;
  }
  log(`dynamic run finished after ${stats.rounds} round(s).`);
}

phase('Verify');
const verify = await agent(verifyPrompt(stats.filesAttempted), { schema: VERIFY_SCHEMA, phase: 'Verify', label: 'verify' });
const out = finalSummary(verify || { translatableFiles: -1, translatableHan: -1, protectedFiles: -1, scrubFiles: -1, attemptedStillHan: [] }, stats);
return out;
