/**
 * TCVDB **Real Device** Verification: deletion semantics and guardrails for clearMemoryContent / deleteL0BySession
 *
 * Difference from mock unit tests: here, the real VDB is connected, verifying VDB's own behavior, rather than us
 * Assumptions about it. Focus on confirming the few things that were previously only inferred:
 *   1. filter when not empty, delete only deletes the matched documents, without affecting other team/agent
 *   2. Null/empty session guarding is indeed effective on the real device link and does not send deletion requests
 *   3.  Can continue to write after clearing, clearing repeatedly is idempotent
 *
 * Security conventions:
 *   - Operate in an **independent temporary database** (named with a timestamp + PID), do not touch any existing database
 *   - Drop the entire temporary database in the finally block, so no residue remains even if it fails
 *   - Read credentials only from environment variables, do not write to disk or print them
 *
 * Prerequisite: The maximum number of VDB instance collections is 1500, and each memory database occupies 8 collections.
 * If there is insufficient remaining capacity, createCollection will fail with code=15129 and enter degraded mode,
 * causing subsequent writes to silently fail. You can first use scripts/probe-vdb-capacity.ts to check the remaining capacity.
 *
 * Run (requires sourcing .env.devcloud to provide VDB_URL / VDB_API_KEY):
 *   node --import tsx scripts/verify-tcvdb-clear.ts
 */
import { TcvdbMemoryStore } from "../src/core/store/tcvdb.js";
import { TcvdbClient } from "../src/core/store/tcvdb-client.js";

const VDB_URL = process.env.VDB_URL;
const VDB_API_KEY = process.env.VDB_API_KEY;
const VDB_USERNAME = process.env.VDB_USERNAME ?? "root";

if (!VDB_URL || !VDB_API_KEY) {
  console.error("Environment variable VDB_URL / VDB_API_KEY required (do not write into code or command line history)");
  process.exit(2);
}

/** Standalone temporary database: with timestamp + PID, to avoid conflicts with any existing database or concurrent instances. */
const TMP_DB = `clearverify-${Date.now().toString(36)}-${process.pid}`;

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {},
  error: (m: string) => console.error(`  [store-error] ${m}`),
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
}

interface Scope { teamId: string; agentId: string; userId: string; sessionId: string }

/** Two mutually independent scopes, used to verify that "clearing A does not affect B". */
const A: Scope = { teamId: "vt-a", agentId: "agt-a", userId: "vu-a", sessionId: "vs-a" };
const B: Scope = { teamId: "vt-b", agentId: "agt-b", userId: "vu-b", sessionId: "vs-b" };
/** Same team as A but different agent — verify agent-level isolation. */
const A2: Scope = { teamId: "vt-a", agentId: "agt-a2", userId: "vu-a", sessionId: "vs-a2" };

function l0(scope: Scope, id: string, text: string) {
  return {
    id,
    sessionKey: scope.sessionId,
    sessionId: scope.sessionId,
    teamId: scope.teamId,
    taskId: "",
    userId: scope.userId,
    agentId: scope.agentId,
    role: "user",
    messageText: text,
    recordedAt: new Date().toISOString(),
    timestamp: Date.now(),
  };
}

/** Create an L1 record (structure aligned with MemoryRecord). */
function l1(scope: Scope, id: string, content: string) {
  const now = new Date().toISOString();
  return {
    id,
    content,
    type: "episodic" as const,
    priority: 50,
    scene_name: "verify",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 1,
    sessionKey: scope.sessionId,
    sessionId: scope.sessionId,
    teamId: scope.teamId,
    userId: scope.userId,
    agentId: scope.agentId,
    taskId: "",
  };
}

/** L1 Counting: Aggregated by (team, agent, user), consistent with the scope of clearMemoryContent. */
async function countL1(store: TcvdbMemoryStore, scope: Scope): Promise<number> {
  return store.countL1({
    teamId: scope.teamId, agentId: scope.agentId, userId: scope.userId,
  });
}

/** Poll L1 to the expected number. */
async function waitCountL1(
  store: TcvdbMemoryStore, scope: Scope, want: number, timeoutMs = 25_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await countL1(store, scope);
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/** VDB writes to a queryable system with second-level latency, polling until the expected count is reached (or returning the actual value after timeout). */
async function waitCount(
  store: TcvdbMemoryStore, scope: Scope, want: number, timeoutMs = 25_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await store.countL0({
      teamId: scope.teamId, agentId: scope.agentId,
      userId: scope.userId, sessionId: scope.sessionId,
    });
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/** Guardrail class assertion: does not rely on library data, any schema should hold. */
async function runGuardChecks(store: TcvdbMemoryStore): Promise<void> {
  console.log("\n4. Null value guard (must be rejected before sending the deletion request)");
  for (const bad of [
    { teamId: "", agentId: "agt-x" },
    { teamId: "vt-x", agentId: "" },
    { teamId: "  ", agentId: "  " },
  ]) {
    let threw = false;
    try { await store.clearMemoryContent(bad); } catch { threw = true; }
    check(`clearMemoryContent rejects teamId="${bad.teamId}" agentId="${bad.agentId}"`, threw);
  }
  for (const badSid of ["", "   "]) {
    let threw = false;
    try { await store.deleteL0BySession(badSid, { teamId: "vt-x", agentId: "agt-x" }); }
    catch { threw = true; }
    check(`deleteL0BySession rejects empty sessionId ("${badSid}")`, threw);
  }
}

async function main() {
  const store = new TcvdbMemoryStore({
    url: VDB_URL!,
    username: VDB_USERNAME,
    apiKey: VDB_API_KEY!,
    database: TMP_DB,
    embeddingModel: "bge-base-zh",
    timeout: 30_000,
    logger: silentLogger,
  });

  console.log(`\nTemporary database: ${TMP_DB} (deleted automatically after running`);
  await store.init();

  if ((store as unknown as { degraded: boolean }).degraded) {
    console.error(
      "\n✗ store is in degraded mode, collection creation failed.\n" +
      "  Common reason: VDB instance collection count has reached the limit of 1500.\n" +
      "  You can first run scripts/probe-vdb-capacity.ts to check the remaining capacity.\n"
    );
    process.exit(1);
  }

  try {
    console.log("\nPreparing data (L0 + L1)");
    for (let i = 0; i < 3; i++) await store.upsertL0(l0(A, `rec-a-${i}`, `A msg ${i}`), undefined);
    for (let i = 0; i < 2; i++) await store.upsertL0(l0(B, `rec-b-${i}`, `B msg ${i}`), undefined);
    await store.upsertL0(l0(A2, "rec-a2-0", "A2 msg"), undefined);

    // L1: This is the focus of this round — the L0 was only written before, and the L1 deletion path was never actually verified
    let l1WriteOk = true;
    for (let i = 0; i < 2; i++) {
      l1WriteOk = (await store.upsertL1(l1(A, `mem-a-${i}`, `A memory ${i}`))) && l1WriteOk;
    }
    l1WriteOk = (await store.upsertL1(l1(B, "mem-b-0", "B memory"))) && l1WriteOk;
    l1WriteOk = (await store.upsertL1(l1(A2, "mem-a2-0", "A2 memory"))) && l1WriteOk;
    check("L1 write calls all return success", l1WriteOk);

    const aN = await waitCount(store, A, 3);
    const bN = await waitCount(store, B, 2);
    const a2N = await waitCount(store, A2, 1);
    check("A L0 write 3", aN === 3, `actual ${aN}`);
    check("B L0 write 2", bN === 2, `actual ${bN}`);
    check("A2 L0 write 1 (same team, different agent)", a2N === 1, `actual ${a2N}`);

    const aL1 = await waitCountL1(store, A, 2);
    const bL1 = await waitCountL1(store, B, 1);
    const a2L1 = await waitCountL1(store, A2, 1);
    check("A L1 write 2", aL1 === 2, `actual ${aL1}`);
    check("B L1 write 1", bL1 === 1, `actual ${bL1}`);
    check("A2 L1 write 1", a2L1 === 1, `actual ${a2L1}`);

    if (aN !== 3 || bN !== 2 || a2N !== 1 || aL1 !== 2 || bL1 !== 1) {
      console.error("\nData not ready, subsequent assertions are meaningless, exit early");
      return;
    }

    // ── 1. Scope Correctness: The most critical one on real devices──
    console.log("\n1. clearMemoryContent scope (verified simultaneously with L0 + L1)");
    const r = await store.clearMemoryContent({ teamId: A.teamId, agentId: A.agentId });
    check("returns l0Deleted=3", r.l0Deleted === 3, `actual ${r.l0Deleted}`);
    check("returns l1Deleted=2", r.l1Deleted === 2, `actual ${r.l1Deleted}`);

    check("A L0 Cleared", (await waitCount(store, A, 0)) === 0);
    check("A L1 Cleared", (await waitCountL1(store, A, 0)) === 0);
    check("B L0 Unaffected (Not Deleted Across Teams)", (await waitCount(store, B, 2)) === 2);
    check("B L1 Unaffected", (await waitCountL1(store, B, 1)) === 1);
    check("A2 L0 Unaffected (Not Deleted Across Agents)", (await waitCount(store, A2, 1)) === 1);
    check("A2 L1 Unaffected (Not Deleted Across Agents)", (await waitCountL1(store, A2, 1)) === 1);

    // ── 2. Idempotency ──
    console.log("\n2. Idempotency");
    const again = await store.clearMemoryContent({ teamId: A.teamId, agentId: A.agentId });
    check("clearing L0 again returns 0", again.l0Deleted === 0, `actual ${again.l0Deleted}`);
    check("clearing L1 again returns 0", again.l1Deleted === 0, `actual ${again.l1Deleted}`);

    // ── 3. Can continue to write after clearing (Requirements acceptance criteria) ──
    console.log("\n3. Can continue to write after clearing");
    await store.upsertL0(l0(A, "rec-a-new", "A msg after clear"), undefined);
    await store.upsertL1(l1(A, "mem-a-new", "A memory after clear"));
    check("After clearing, new writes to L0 are visible", (await waitCount(store, A, 1)) === 1);
    check("After clearing, new writes to L1 are visible", (await waitCountL1(store, A, 1)) === 1);

    // ── 4. Guardrails ──
    await runGuardChecks(store);
    check("Barrier triggered, B data intact", (await waitCount(store, B, 2)) === 2);

    // ── 5. deleteL0BySession normal path ──
    console.log("\n5. deleteL0BySession normal path");
    const n = await store.deleteL0BySession(B.sessionId, {
      teamId: B.teamId, agentId: B.agentId, userId: B.userId,
    });
    check("Returns 2 when deleting by session", n === 2, `actual ${n}`);
    check("B is cleared", (await waitCount(store, B, 0)) === 0);
    check("A2 is unaffected", (await waitCount(store, A2, 1)) === 1);

    console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
  } finally {
    // Clear the temporary database regardless of success or failure
    try {
      const admin = new TcvdbClient({
        url: VDB_URL!, username: VDB_USERNAME, apiKey: VDB_API_KEY!,
        database: TMP_DB, timeout: 30_000, logger: silentLogger,
      });
      await admin.dropDatabase(TMP_DB);
      console.log(`Temporary database ${TMP_DB} deleted`);
    } catch (err) {
      console.error(
        `⚠️ Temporary database ${TMP_DB} deletion failed, please manually clean up: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await store.close?.();
  }

  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("verify crashed:", err);
  process.exitCode = 1;
});
