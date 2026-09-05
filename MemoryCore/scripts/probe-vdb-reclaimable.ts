/**
 * One-time troubleshooting script (**read-only**): identify one-time test residual databases on VDB that can be safely cleaned up.
 *
 * Background: The number of instance collections has reached the limit of 1500/1500, and creating a new database is not possible. Test residue needs to be recycled first.
 *
 * Judgment rules (only recognize libraries with **explicit one-time test features**, preferring to miss rather than mistakenly harm):
 *   - `memory-tdai-test-*`         Automated e2e generation, with random run id in the name
 *   - `verify_memory_bm25_*`      BM25 verification script generation, with timestamp in the name
 *   - `clearverify-*`              Clear verification script generation for this time
 *   - `*_probe` / `*probe*`        Probing temporary libraries
 *
 * Clearly **exclude** (possibly long-term environments used by others):
 *   - memory-tencentdb-testing-*   Shared test database
 *   - memory_dev_*                Development environment database
 *   - All databases that do not match the above patterns
 *
 * This script only outputs lists and statistics, **does not execute any deletions**.
 */
import { TcvdbClient } from "../src/core/store/tcvdb-client.js";

const VDB_URL = process.env.VDB_URL;
const VDB_API_KEY = process.env.VDB_API_KEY;

if (!VDB_URL || !VDB_API_KEY) {
  console.error("Environment variable VDB_URL / VDB_API_KEY required");
  process.exit(2);
}

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** A clear one-time test library feature. */
const DISPOSABLE_PATTERNS: Array<{ name: string; test: (db: string) => boolean }> = [
  { name: "memory-tdai-test-*", test: (d) => d.startsWith("memory-tdai-test-") },
  { name: "verify_memory_bm25_*", test: (d) => d.startsWith("verify_memory_bm25_") },
  { name: "clearverify-*", test: (d) => d.startsWith("clearverify-") },
];

/** Explicitly protect, never include in the cleanup list. */
const PROTECTED_PATTERNS: Array<(db: string) => boolean> = [
  (d) => d.startsWith("memory-tencentdb-testing"),
  (d) => d.startsWith("memory_dev_"),
];

function classify(db: string): { disposable: boolean; reason: string } {
  for (const p of PROTECTED_PATTERNS) {
    if (p(db)) return { disposable: false, reason: "protected" };
  }
  for (const p of DISPOSABLE_PATTERNS) {
    if (p.test(db)) return { disposable: true, reason: p.name };
  }
  return { disposable: false, reason: "unknown-keep" };
}

async function main() {
  const client = new TcvdbClient({
    url: VDB_URL!,
    username: process.env.VDB_USERNAME ?? "root",
    apiKey: VDB_API_KEY!,
    database: process.env.VDB_DATABASE ?? "default",
    timeout: 30_000,
    logger: silent,
  });

  const dbResp = await client.request<{ databases?: string[] }>("/database/list", {});
  const dbs = dbResp.databases ?? [];

  let totalCols = 0;
  let reclaimable = 0;
  const byReason = new Map<string, { dbs: number; cols: number }>();
  const keepUnknown: string[] = [];

  for (const db of dbs) {
    let n = 0;
    try {
      const r = await client.request<{ collections?: Array<{ collection?: string }> }>(
        "/collection/list", { database: db },
      );
      n = (r.collections ?? []).length;
    } catch { /* Count as 0 if not counted */ }
    totalCols += n;

    const { disposable, reason } = classify(db);
    const slot = byReason.get(reason) ?? { dbs: 0, cols: 0 };
    slot.dbs++;
    slot.cols += n;
    byReason.set(reason, slot);

    if (disposable) reclaimable += n;
    else if (reason === "unknown-keep") keepUnknown.push(db);
  }

  console.log(`Total number of databases: ${dbs.length}`);
  console.log(`Total number of collections: ${totalCols} / 1500 (remaining ${1500 - totalCols})\n`);

  console.log("By category:");
  for (const [reason, s] of [...byReason.entries()].sort((a, b) => b[1].cols - a[1].cols)) {
    const tag = DISPOSABLE_PATTERNS.some((p) => p.name === reason) ? "Cleanable" : "Retain";
    console.log(`  [${tag}] ${reason.padEnd(24)} ${String(s.dbs).padStart(4)} db(s), ${String(s.cols).padStart(5)} collection(s)`);
  }

  console.log(`\nReclaimable set: ${reclaimable} (remaining after cleanup approx. ${1500 - totalCols + reclaimable})`);
  console.log(`Unrecognized, conservatively kept libraries: ${keepUnknown.length} items`);
  if (keepUnknown.length) console.log(`   Example: ${keepUnknown.slice(0, 10).join(", ")}`);
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
