/**
 * One-time troubleshooting script (**read-only**): count the number of VDB databases and collection usage, and identify the source of exceeding collection limits.
 *
 * Background: The maximum number of VDB instance collections is 1500. Each memory database occupies 8 collections, so before creating a new database, you need to
 * confirm there is still capacity, otherwise createCollection will fail with code=15129 and enter the degraded
 * mode, causing all subsequent writes to silently fail (this has been tested and confirmed).
 *
 * This script does not perform any creation/deletion, only outputs statistics for manual judgment on which databases to clean.
 */
import { TcvdbClient } from "../src/core/store/tcvdb-client.js";

const VDB_URL = process.env.VDB_URL;
const VDB_API_KEY = process.env.VDB_API_KEY;

if (!VDB_URL || !VDB_API_KEY) {
  console.error("Environment variable VDB_URL / VDB_API_KEY required");
  process.exit(2);
}

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function main() {
  const client = new TcvdbClient({
    url: VDB_URL!,
    username: process.env.VDB_USERNAME ?? "root",
    apiKey: VDB_API_KEY!,
    database: process.env.VDB_DATABASE ?? "default",
    timeout: 30_000,
    logger: silent,
  });

  // TcvdbClient does not encapsulate the list interface, directly calling the underlying request (read-only)
  const dbResp = await client.request<{ databases?: string[] }>("/database/list", {});
  const dbs = dbResp.databases ?? [];
  console.log(`Total number of databases: ${dbs.length}`);

  const counts: Array<{ db: string; n: number }> = [];
  let total = 0;
  for (const db of dbs) {
    try {
      const r = await client.request<{ collections?: Array<{ collection?: string }> }>(
        "/collection/list", { database: db },
      );
      const n = (r.collections ?? []).length;
      counts.push({ db, n });
      total += n;
    } catch {
      counts.push({ db, n: -1 }); // No permission or exception
    }
  }

  console.log(`Total: ${total} / 1500 (remaining ${1500 - total}`);

  const leftovers = counts.filter((c) => c.db.startsWith("clearverify-"));
  console.log(`\nLeftover library clearverify-* in this verification script: ${leftovers.length} items`);
  for (const c of leftovers) console.log(`  ${c.db}  (${c.n} collections)`);

  counts.sort((a, b) => b.n - a.n);
  console.log("\nTop 15 collections:");
  for (const c of counts.slice(0, 15)) {
    console.log(`  ${String(c.n).padStart(5)}  ${c.db}`);
  }
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
