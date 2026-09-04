#!/usr/bin/env node
// scripts/zh-en/leak-count.mjs
// Deterministic ZH->EN census + worklist generator. Zero dependencies, node >= 18.
//
//   node scripts/zh-en/leak-count.mjs                  human report + writes worklist.json
//   node scripts/zh-en/leak-count.mjs --json           machine-readable (workflow scanner)
//   node scripts/zh-en/leak-count.mjs --json --top 50  cap the worklist/cluster list
//   node scripts/zh-en/leak-count.mjs --file <path>    single-file Han count  (agents)
//
// A file is "translatable" only if it is git-tracked, has Han script, and is not
// binary / protected / scrub. "Done" means: translatable == 0 files.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectedGlobs, scrubGlobs, binaryExts } from './zh-en.config.mjs';

const HAN = /\p{Script=Han}/gu;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.cwd()); // must be the repo root (git workdir)

// ---- glob matching over '/'-split paths. `**` = any number of segments.
// A pattern with no '/' matches the basename at any depth. ----
function segRe(seg) {
  let out = '^';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if ('\\^$.|?+()[]{}'.includes(ch)) out += '\\' + ch;
    else out += ch;
  }
  return new RegExp(out + '$');
}

function matchFrom(patSegs, pi, pathSegs, si) {
  while (pi < patSegs.length) {
    if (patSegs[pi] === '**') {
      for (let k = si; k <= pathSegs.length; k++) {
        if (matchFrom(patSegs, pi + 1, pathSegs, k)) return true;
      }
      return false;
    }
    if (si >= pathSegs.length || !segRe(patSegs[pi]).test(pathSegs[si])) return false;
    pi++; si++;
  }
  return si === pathSegs.length;
}

function globMatch(glob, path) {
  const p = glob.split('/');
  const s = path.split('/');
  if (p[0] === '**') {
    for (let start = 0; start <= s.length; start++) {
      if (matchFrom(p, 1, s, start)) return true;
    }
    return false;
  }
  if (!glob.includes('/')) return segRe(glob).test(s[s.length - 1]); // basename anywhere
  return matchFrom(p, 0, s, 0);
}

function classify(path) {
  if (scrubGlobs.some((g) => globMatch(g, path))) return 'scrub';
  if (binaryExts.includes(extname(path).slice(1).toLowerCase())) return null; // binary -> ignored
  if (protectedGlobs.some((g) => globMatch(g, path))) return 'protected';
  return 'translatable';
}

function hanOf(text) {
  const m = text.match(HAN);
  return m ? m.length : 0;
}

function readText(root, rel) {
  const buf = readFileSync(join(root, rel));
  if (buf.includes(0)) return null; // binary-ish
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

function analyze() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const buckets = { translatable: [], protected: [], scrub: [] };
  const byHash = new Map(); // han-content hash -> cluster
  for (const rel of files) {
    if (rel.startsWith('.') && rel.includes('/')) continue; // hidden files in subdirs
    if (rel.startsWith('scripts/zh-en/')) continue;         // this tooling itself
    const text = readText(root, rel);
    if (text == null) continue;
    const han = hanOf(text);
    if (han === 0) continue;
    const cls = classify(rel);
    if (!cls) continue; // binary
    buckets[cls].push({ path: rel, han });
    if (cls === 'translatable') {
      // Cluster files whose Chinese-only text is byte-identical (e.g. the offload
      // prompt copies that must be translated in lockstep to the SAME English).
      const norm = (text.match(HAN) || []).join('');
      const hash = createHash('sha1').update(norm).digest('hex').slice(0, 12);
      if (!byHash.has(hash)) byHash.set(hash, { id: hash, files: [], han: 0 });
      const c = byHash.get(hash);
      c.files.push({ path: rel, han });
      c.han += han;
    }
  }
  const clusters = [...byHash.values()].sort((a, b) => b.han - a.han);
  const sum = (arr) => arr.reduce((n, x) => n + x.han, 0);
  const translatableFiles = buckets.translatable.length;
  const translatableHan = sum(buckets.translatable);
  return {
    root,
    translatable: { files: buckets.translatable, count: translatableFiles, han: translatableHan },
    protected: { files: buckets.protected, count: buckets.protected.length, han: sum(buckets.protected) },
    scrub: { files: buckets.scrub, count: buckets.scrub.length, han: sum(buckets.scrub) },
    clusters,
  };
}

const argv = process.argv.slice(2);
if (argv.includes('--file')) {
  const rel = argv[argv.indexOf('--file') + 1];
  const p = resolve(root, rel);
  const s = readTextSyncSafe(p);
  console.log(s == null ? `${rel}\t0` : `${rel}\t${hanOf(s)}`);
  process.exit(0);
}
if (argv.includes('--lines')) {
  // Print only the lines that contain Han, numbered, with exact text - so workers
  // can target their Edits without reading whole (mostly-English) files.
  const rel = argv[argv.indexOf('--lines') + 1];
  const s = readTextSyncSafe(resolve(root, rel));
  if (s == null) process.exit(0);
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (hanOf(lines[i]) > 0) console.log(`${i + 1}\t${lines[i]}`);
  }
  process.exit(0);
}

const stat = analyze();
const top = (() => {
  const i = argv.indexOf('--top');
  return i >= 0 ? Number(argv[i + 1]) : Infinity;
})();

if (argv.includes('--json')) {
  const slim = {
    root: stat.root,
    summary: {
      translatableFiles: stat.translatable.count,
      translatableHan: stat.translatable.han,
      protectedFiles: stat.protected.count,
      protectedHan: stat.protected.han,
      scrubFiles: stat.scrub.count,
      scrubHan: stat.scrub.han,
    },
    translatable: stat.translatable.files.sort((a, b) => b.han - a.han),
    protected: stat.protected.files.sort((a, b) => b.han - a.han),
    scrub: stat.scrub.files.sort((a, b) => b.han - a.han),
    clusters: stat.clusters.slice(0, top).map((c) => ({ id: c.id, han: c.han, files: c.files.map((f) => f.path) })),
  };
  process.stdout.write(JSON.stringify(slim, null, 0) + '\n');
  process.exit(0);
}

// ---- human report ----
const worklistPath = join(here, 'worklist.json');
const full = {
  generatedAt: new Date().toISOString(),
  root: stat.root,
  summary: {
    translatableFiles: stat.translatable.count,
    translatableHan: stat.translatable.han,
    protectedFiles: stat.protected.count,
    protectedHan: stat.protected.han,
    scrubFiles: stat.scrub.count,
    scrubHan: stat.scrub.han,
  },
  translatable: stat.translatable.files.sort((a, b) => b.han - a.han),
  clusters: stat.clusters.map((c) => ({
    id: c.id,
    han: c.han,
    files: c.files.map((f) => ({ path: f.path, han: f.han })),
  })),
};
writeFileSync(worklistPath, JSON.stringify(full, null, 2) + '\n');

const T = stat.translatable, P = stat.protected, S = stat.scrub;
console.log(`ZH->EN census  (repo root: ${stat.root})`);
console.log(`----------------------------------------`);
console.log(`  translatable   ${String(T.count).padStart(4)} files   ${String(T.han).padStart(7)} Han   <- the work`);
console.log(`  protected      ${String(P.count).padStart(4)} files   ${String(P.han).padStart(7)} Han   (stays Chinese by design)`);
console.log(`  scrub (delete) ${String(S.count).padStart(4)} files   ${String(S.han).padStart(7)} Han   (committed junk - git rm)`);
console.log(`----------------------------------------`);
console.log(`"Done" = translatable files == 0. worklist.json written -> ${worklistPath}`);
console.log(`\nTop translatable files (${Math.min(T.files.length, 30)} shown of ${T.count}):`);
for (const f of T.files.slice(0, 30)) console.log(`   ${String(f.han).padStart(7)}  ${f.path}`);
console.log(`\nScrub candidates to delete:`);
for (const f of S.files.sort((a, b) => b.han - a.han)) console.log(`   ${String(f.han).padStart(7)}  ${f.path}`);

function readTextSyncSafe(p) {
  try {
    const buf = readFileSync(p);
    if (buf.includes(0)) return null;
    let s = buf.toString('utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  } catch {
    return null;
  }
}
