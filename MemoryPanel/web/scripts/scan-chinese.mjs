#!/usr/bin/env node
/**
 * scan-chinese.mjs — Scan for hardcoded Chinese residue under src (excluding i18n/locale files)
 *
 * Usage:
 *   node scripts/scan-chinese.mjs              # Scan and output report
 *   node scripts/scan-chinese.mjs --strict     # Exit with a non-zero exit code when residuals are found (for CI)
 *
 * Rules:
 *   - Scan .ts / .tsx files
 *   - Exclude the src/i18n/ directory (locale files are themselves Chinese/English mapping tables)
 *   - Exclude code comments (lines starting with //, *, or /*)
 *   - Detect lines containing CJK unified ideographs (U+4E00–U+9FFF)
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcRoot = join(__dirname, '..', 'src');

/** Recursively collect .ts/.tsx files, excluding specified directories */
function walk(dir, excludeDirs = []) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      out.push(...walk(fullPath, excludeDirs));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

/** Determine if a line is a pure comment line (starting with //, *, or /*) */
function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

/**
 * Strip inline comments (// to end of line), but avoid mistakenly deleting // within string literals.
 * Rough method: scan from left to right, track quote state, and truncate only when // is encountered outside quotes.
 */
function stripInlineComment(line) {
  let inSingle = false;  // single quotes
  let inDouble = false;  // double quotes
  let inTemplate = false; // template string backticks
  let escaped = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === '`') inTemplate = !inTemplate;
    else if (!inSingle && !inDouble && !inTemplate && ch === '/' && next === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

const CJK_REGEX = /[\u4e00-\u9fff]/;

function scan() {
  const excludeDirs = ['i18n'];
  const files = walk(srcRoot, excludeDirs);

  const results = [];
  let totalHits = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const hits = [];

    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      const codeOnly = stripInlineComment(line);
      if (CJK_REGEX.test(codeOnly)) {
        hits.push({ line: i + 1, content: line });
        totalHits++;
      }
    });

    if (hits.length > 0) {
      results.push({ file: relative(process.cwd(), file), hits });
    }
  }

  return { results, totalHits };
}

const { results, totalHits } = scan();

console.log('═══════════════════════════════════════════════════════════');
console.log('   Chinese residue scan (excluding src/i18n/, excluding code comments)');
console.log('═══════════════════════════════════════════════════════════\n');

if (results.length === 0) {
  console.log('✅ No hardcoded Chinese residue found.\n');
  process.exit(0);
}

console.log(`Found ${results.length} files, ${totalHits} lines containing Chinese residue:\n`);

for (const { file, hits } of results.sort((a, b) => b.hits.length - a.hits.length)) {
  console.log(`📄 ${file} (${hits.length} lines)`);
  for (const { line, content } of hits) {
    console.log(`   ${String(line).padStart(4)}: ${content.trim().slice(0, 120)}`);
  }
  console.log('');
}

console.log(`───────────────────────────────────────────────────────────`);
console.log(`Total: ${results.length} files, ${totalHits} Chinese residue lines`);
console.log(`───────────────────────────────────────────────────────────\n`);

if (process.argv.includes('--strict')) {
  process.exit(1);
}
