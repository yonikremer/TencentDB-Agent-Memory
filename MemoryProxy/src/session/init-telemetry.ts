/**
 * session_init telemetry decorator (internal usage telemetry §7.2 Chunk 2 A/B).
 *
 * Design: leave the 30+ `store.set(status:"initialized")` points inside handleSessionInit
 *         alone; read state once just before and just after the top-level entry, and emit
 *         a row only when `prev !== "initialized" && after === "initialized"`.
 *
 * Hard constraints (§7.-1):
 *   - return void synchronously, never throw
 *   - swallow exceptions raised inside the sink
 *   - no-op when there is no state / state unchanged / pending → pending
 */
import type { SessionInitStatus } from "./types.js";
import type { SessionStore } from "./store.js";
import { writeSessionInitRow, type SessionInitLogInput } from "../clickhouse.js";

/** Telemetry decorator input. sink defaults to the real writeSessionInitRow and is injectable for testing. */
export interface EmitSessionInitTelemetryArgs {
  store: SessionStore;
  compositeKey: string;
  /** store.get(...)?.status when handleSessionInit is entered (pass "uninitialized" if undefined) */
  prevStatus: SessionInitStatus;
  /** "claude-code" | "codebuddy" */
  agentSource: string;
  /** First raw line grabbed from the log when the bypass branch is taken (optional) */
  bypassReason?: string;
  /** Test injection point; calls clickhouse.writeSessionInitRow by default */
  sink?: (input: SessionInitLogInput) => void;
}

/**
 * Emit one session_init telemetry row when the status has just moved from
 * non-initialized to initialized. Everything else is a no-op.
 */
export function emitSessionInitTelemetryIfCompleted(args: EmitSessionInitTelemetryArgs): void {
  try {
    if (args.prevStatus === "initialized") return; // steady state, nothing to emit
    const state = args.store.get(args.compositeKey);
    if (!state) return; // never set → e.g. sessionKey=unknown
    if (state.status !== "initialized") return; // still pending mid-way → not completed

    const info = state.sessionInfo;
    const input: SessionInitLogInput = {
      timestamp: new Date().toISOString(),
      sessionKey: args.compositeKey,
      spaceId: info?.space_id,
      userId: info?.user_id,
      teamId: info?.team_id,
      agentId: info?.agent_id,
      agentSource: args.agentSource,
      bypassed: state.bypassed === true,
      bypassReason: args.bypassReason ?? "",
      finalStatus: "initialized",
    };
    const sink = args.sink ?? writeSessionInitRow;
    try {
      sink(input);
    } catch {
      // sink threw → decorator stays silent; telemetry must never block business
    }
  } catch {
    // the decorator itself must not throw either
  }
}
