#!/usr/bin/env node
// scripts/zh-en/local-translate.mjs
// Cheap line-by-line ZH->EN translator driven by a LOCAL ollama model instead of
// cloud agents. For every git-tracked, non-protected/non-scrub file (same census
// as leak-count.mjs) it finds each line containing Han and asks the local model to
// rewrite that ONE line: translate the human-language Chinese to English while
// copying every code/identifier/quote/${...} token verbatim.
//
//   node scripts/zh-en/local-translate.mjs --prefix deploy            # a slice
//   node scripts/zh-en/local-translate.mjs --all                      # whole census
//   node scripts/zh-en/local-translate.mjs --file <path>              # one file
//   ... --model ornith-1.5:9b  (default)   --dry-run                  # preview only
//   ... --limit 50                        --sleep-ms 0
//
// Safety: a line is only replaced when the model returns a single line whose Han
// count dropped and which is non-empty. Files/lines the model fails stay Chinese
// (they show up in the next census). Run package gates (tsc/vitest/sh -n/py_compile)
// before committing.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HAN = /\p{Script=Han}/gu;
const argv = process.argv.slice(2);
const pick = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const MODEL = pick('--model') || 'ornith-1.5:9b';
const BASE = pick('--base') || 'http://127.0.0.1:11434';
const openai = argv.includes('--openai'); // llama.cpp server speaks OpenAI /v1/chat/completions
const prefixes = (pick('--prefix') || '').split(',').filter(Boolean);
const singleFile = pick('--file');
const dryRun = argv.includes('--dry-run');
const limit = Number(pick('--limit') || Infinity);
const batchSize = Number(pick('--batch') || 6);
const sleepMs = Number(pick('--sleep-ms') || 10);

const SYS = [
  'You rewrite a SINGLE LINE of a source file, translating its human-language Chinese to English.',
  'Return ONLY the rewritten line - no explanations, no markdown fences, no surrounding quotes, no line numbers, no trailing period added.',
  'Preserve EXACTLY every non-Chinese token: leading whitespace/indentation, identifiers, code, quote style, ${...} interpolation, escapes, URLs, file paths, punctuation that belongs to code.',
  'Translate only the human-language Chinese text into natural, idiomatic English.',
  'If the line is already English or has no translatable Chinese, return it unchanged.',
].join(' ');

function hanCount(s) { const m = s.match(HAN); return m ? m.length : 0; }

async function askChat(lines, isBatch) {
  const sys = isBatch
    ? SYS + ' MULTI-LINE MODE: you receive several CONSECUTIVE lines of the same file. Translate each line to English and return EXACTLY the same number of lines, in the same order, one translated line per output line. Keep each line\'s own comment markers (//, *, #) and indentation. Never merge or split lines.'
    : SYS;
  const body = openai
    ? {
        model: MODEL,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: lines.join('\n') },
        ],
        temperature: 0.1,
        max_tokens: 2048,
        reasoning_effort: 'none', // Spark is a CoT model; disable reasoning or it burns the whole budget
        stream: false,
      }
    : {
        model: MODEL,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: lines.join('\n') },
        ],
        stream: false,
        options: { temperature: 0.1 },
        keep_alive: '30m',
      };
  const url = openai ? `${BASE}/v1/chat/completions` : `${BASE}/api/chat`;
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`server HTTP ${r.status}`);
  const j = await r.json();
  if (openai) return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return (j.message && j.message.content) || '';
}

function bestSingle(line) {
  // Normalize one model reply into a candidate translated line, or null.
  let nl = (line || '').trim();
  if (!nl || nl.includes('\n')) return null;
  return nl;
}

const Q = /['"`]/g;
function quotes(s) { return (s.match(Q) || []).length; }
function isCommentLine(s) { return /^\s*(\/\/|\*|#)/.test(s); }
function suspicious(orig, nl) {
  // On code lines (not comments), a translation must never drop string quotes -
  // Spark sometimes translates a string's content but removes the enclosing quotes.
  if (!isCommentLine(orig) && quotes(nl) < quotes(orig)) return true;
  // Preserve indentation contract.
  return false;
}

async function translateFile(rel) {
  const full = join(process.cwd(), rel);
  const lines = readFileSync(full, 'utf8').split('\n');
  const targets = [];
  lines.forEach((l, i) => { if (hanCount(l) > 0) targets.push(i); });
  if (!targets.length) return { rel, han: 0, changed: 0, failed: 0, tried: targets.length };

  // Contiguous Han runs (usually a comment block) -> chunks of up to batchSize.
  const chunks = [];
  let run = [];
  for (const i of targets) {
    if (run.length && i !== run[run.length - 1] + 1) { chunks.push(run); run = []; }
    run.push(i);
    if (run.length === batchSize) { chunks.push(run); run = []; }
  }
  if (run.length) chunks.push(run);

  const samples = [];
  let changed = 0, failed = 0, done = 0;

  const acceptLine = (orig, raw) => {
    let nl = bestSingle(raw);
    if (!nl) return null;
    const lead = orig.match(/^[ \t]*/)[0];
    nl = lead + nl.trimStart().replace(/^[ \t]+/, '');
    if (hanCount(nl) >= hanCount(orig)) return null;
    if (suspicious(orig, nl)) return null;
    return nl;
  };
  const applyOne = async (i) => { // per-line fallback path
    const orig = lines[i];
    const raw = await askChat([orig], false);
    const nl = acceptLine(orig, raw);
    if (!nl) return false;
    lines[i] = nl; changed++;
    if (dryRun && samples.length < 4) samples.push([orig, nl]);
    return true;
  };

  for (const chunk of chunks) {
    if (done >= limit) break;
    done += chunk.length;
    const origs = chunk.map((i) => lines[i]);
    let resp = '';
    try {
      resp = await askChat(origs, true);
      if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
    } catch { /* fall through to per-line */ }
    let out = (resp || '').trimEnd().split('\n').filter((s, idx, arr) => !(idx === arr.length - 1 && s.trim() === '')); // keep trailing blank as empty line only
    // Keep exactly as many lines as requested (trailing empties trimmed above are fine).
    if (out.length !== chunk.length) {
      // Count mismatch -> retry each line individually.
      for (const i of chunk) { try { await applyOne(i); } catch { failed++; } }
      continue;
    }
    for (let k = 0; k < chunk.length; k++) {
      const i = chunk[k];
      const orig = origs[k];
      const nl = acceptLine(orig, out[k] ?? '');
      if (!nl) { lines[i] = orig; failed++; continue; } // unchanged or unsafe
      lines[i] = nl; changed++;
      if (dryRun && samples.length < 4) samples.push([orig, nl]);
    }
  }
  if (changed && !dryRun) writeFileSync(full, lines.join('\n'), 'utf8');
  return { rel, han: targets.length, changed, failed, tried: done, samples };
}

// ---- resolve file list -----------------------------------------------------
let files = [];
if (singleFile) {
  files = [singleFile];
} else {
  const res = spawnSync(process.execPath, [join(here, 'leak-count.mjs'), '--json'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const census = JSON.parse(res.stdout);
  files = census.translatable.map((f) => f.path);
  if (prefixes.length) files = files.filter((p) => prefixes.some((x) => p === x || p.startsWith(x + '/')));
}

// ---- run --------------------------------------------------------------------
console.log(`local ZH->EN  model=${MODEL}  files=${files.length}  dryRun=${dryRun}`);
let totChanged = 0, totHan = 0, totFail = 0;
const t0 = Date.now();
for (const f of files) {
  try {
    const s = await translateFile(f);
    totHan += s.han; totChanged += s.changed; totFail += s.failed;
    if (s.han) console.log(`  ${String(s.han).padStart(4)} han-lines  ${String(s.changed).padStart(4)} changed  ${String(s.failed).padStart(3)} failed  ${f}`);
    for (const [a, b] of (s.samples || [])) console.log(`     - ${a.slice(0, 120)}\n     + ${b.slice(0, 120)}`);
  } catch (e) {
    console.log(`  ERR ${f}: ${e.message}`);
  }
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s  han-lines=${totHan}  changed=${totChanged}  failed=${totFail}`);
