#!/usr/bin/env node
// scripts/zh-en/plan-slice.mjs
// Turn worklist.json into batched targetClusters for the zh-en-translate workflow.
// Regenerate the census first (node scripts/zh-en/leak-count.mjs) so the worklist is current.
//
//   node scripts/zh-en/plan-slice.mjs \
//     --prefixes MemoryProxy \            (comma list of path prefixes; default all)
//     --exts ts,tsx,js                    (optional comma list to filter by extension)
//     --max-files 12 --max-han 3000       (batch caps)
//
// Prints the args.targetClusters JSON to feed Workflow (target mode).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const worklist = JSON.parse(readFileSync(join(here, 'worklist.json'), 'utf8'));

const argv = process.argv.slice(2);
const pick = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prefixes = (pick('--prefixes') || '').split(',').filter(Boolean);
const excludes = (pick('--exclude') || '').split(',').filter(Boolean);
const exts = (pick('--exts') || '').split(',').map((s) => s.toLowerCase().replace(/^\./, '')).filter(Boolean);
const maxFiles = Number(pick('--max-files') || 12);
const maxHan = Number(pick('--max-han') || 3000);

let files = worklist.translatable.filter((f) => f.han > 0);
if (prefixes.length) files = files.filter((f) => prefixes.some((p) => f.path === p || f.path.startsWith(p + '/')));
if (excludes.length) files = files.filter((f) => !excludes.some((x) => f.path === x || f.path.startsWith(x + '/')));
if (exts.length) files = files.filter((f) => exts.includes(f.path.split('.').pop().toLowerCase()));

// Group by directory so one worker sees a coherent set of related files, then
// chunk each directory into batches respecting the caps.
const byDir = new Map();
for (const f of files) {
  const i = f.path.lastIndexOf('/');
  const dir = i > 0 ? f.path.slice(0, i) : '';
  if (!byDir.has(dir)) byDir.set(dir, []);
  byDir.get(dir).push(f);
}
const clusters = [];
for (const [dir, list] of byDir) {
  list.sort((a, b) => a.han - b.han);
  let cur = { id: null, files: [], han: 0 };
  for (const f of list) {
    if (cur.files.length > 0 && (cur.files.length >= maxFiles || cur.han + f.han > maxHan)) {
      clusters.push(cur);
      cur = { id: null, files: [], han: 0 };
    }
    cur.files.push(f.path);
    cur.han += f.han;
  }
  if (cur.files.length) clusters.push(cur);
}
clusters.forEach((c, i) => {
  c.id = `${c.files.length > 1 ? 'batch' : 'file'}:${String(i + 1).padStart(2, '0')}:${c.han}Han`;
  delete c.han;
});

const totalFiles = clusters.reduce((n, c) => n + c.files.length, 0);
const totalHan = files.reduce((n, f) => n + f.han, 0);
const out = { targetClusters: clusters };
process.stdout.write(JSON.stringify(out, null, 0) + '\n');
console.error(`planned ${clusters.length} batch(es) / ${totalFiles} file(s) / ${totalHan} Han` + (prefixes.length ? ` for [${prefixes.join(', ')}]` : ''));
