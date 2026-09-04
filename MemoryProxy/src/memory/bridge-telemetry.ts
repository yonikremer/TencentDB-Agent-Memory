/**
 * Bridge-side tool-call telemetry helper (shared by memory-bridge + skill-bridge).
 *
 * Design: emit one kind='bridge_call' row whenever an upstream fetch completes (success or failure).
 *      The caller is responsible for redacting the body to <= 512 bytes (this function does no more
 *      cleaning), it only passes it through.
 *
 * Hard constraints (§7.-1):
 *   - synchronously return void
 *   - silently swallow sink exceptions
 *   - body/sub are already prepared by the caller, never read the session store again
 */
import { writeToolCallRow, type ToolCallLogInput } from "../clickhouse.js";

export interface BridgeCallTelemetryInput {
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  /** "claude-code" | "codebuddy" | "unknown" — derived from the sessionKey prefix */
  agentSource: string;
  /** "memory-bridge" | "skill-bridge" */
  bridgeSource: string;
  /** concrete sub string ("atomic/search" / "skill/get" etc.) */
  executedEndpoint: string;
  /** redacted, truncated outbound body (<= 512 bytes) */
  requestBody: string;
  /** upstream HTTP status (pass 0 or 502 on network failure) */
  upstreamStatus: number;
  /** upstream elapsed time in ms */
  elapsedMs: number;
  /**
   * Reason for the pre-flight validation failure. Empty/omitted = the request reached upstream
   * (success or 4xx/5xx). Non-empty = the proxy exited early during pre-flight and never reached
   * the fetcher. See the ToolCallLogInput comment in clickhouse.ts.
   */
  rejectReason?: string;
}

/**
 * Emit one bridge_call telemetry row. The sink defaults to clickhouse.writeToolCallRow.
 * Exceptions are swallowed internally; it never throws.
 */
export function emitBridgeToolCallTelemetry(
  input: BridgeCallTelemetryInput,
  sink: (row: ToolCallLogInput) => void = writeToolCallRow,
): void {
  try {
    const row: ToolCallLogInput = {
      timestamp: new Date().toISOString(),
      sessionKey: input.sessionKey,
      turnSeq: input.turnSeq,
      spaceId: input.spaceId,
      userId: input.userId,
      teamId: input.teamId,
      agentId: input.agentId,
      agentSource: input.agentSource,
      kind: "bridge_call",
      bridgeSource: input.bridgeSource,
      initiatedTool: "",
      executedEndpoint: input.executedEndpoint,
      requestBody: input.requestBody,
      upstreamStatus: input.upstreamStatus,
      elapsedMs: input.elapsedMs,
      rejectReason: input.rejectReason,
    };
    try {
      sink(row);
    } catch {
      // if sink throws, telemetry must never block business
    }
  } catch {
    // also swallow input construction exceptions
  }
}

/**
 * Derive agentSource from a proxy session-key.
 *   "claude-code:conv-abc" → "claude-code"
 *   "codebuddy:conv-abc"   → "codebuddy"
 *   "conv-abc" (no prefix) → "unknown"
 */
export function agentSourceFromSessionKey(sessionKey: string): string {
  const idx = sessionKey.indexOf(":");
  if (idx <= 0) return "unknown";
  return sessionKey.slice(0, idx);
}

/**
 * Pre-flight rejection telemetry helper — the proxy layer rejected the request and it never reached
 * the upstream fetcher.
 *
 * Most pre-flight exits happen before the session ids are even parsed (missing header / bad content-type /
 * invalid json ...), so few stable fields are available. The remaining fields are passed through as optional.
 *
 * It wraps emitBridgeToolCallTelemetry, so kind is still 'bridge_call'; rows are told apart by rejectReason
 * being non-empty. Old dashboard SQL filtering on kind='bridge_call' keeps working unchanged;
 * the new dimension is queried back via `WHERE reject_reason != ''`.
 *
 * Hard constraints: return void synchronously, telemetry must never block business; sessionKey may be empty.
 */
export interface BridgeRejectTelemetryInput {
  /** fill it in if it was derived; in the pre-flight stage (missing header) it can't be, so pass "" */
  sessionKey: string;
  bridgeSource: "memory-bridge" | "skill-bridge";
  /** stable enum value, for GROUP BY — see the tool_call_logs.reject_reason comment */
  rejectReason: string;
  /** HTTP status the proxy returns to the client (401/415/400/...); stored in the upstream_status column */
  httpStatus: number;
  /** fill the subpath if it can already be computed, otherwise "" */
  executedEndpoint?: string;
  /** body may be filled if parsed (the caller truncates it to <=512), otherwise "" */
  requestBody?: string;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  agentSource?: string;
}

export function emitBridgeRejectTelemetry(input: BridgeRejectTelemetryInput): void {
  emitBridgeToolCallTelemetry({
    sessionKey: input.sessionKey,
    spaceId: input.spaceId,
    userId: input.userId,
    teamId: input.teamId,
    agentId: input.agentId,
    agentSource: input.agentSource
      ?? (input.sessionKey ? agentSourceFromSessionKey(input.sessionKey) : "unknown"),
    bridgeSource: input.bridgeSource,
    executedEndpoint: input.executedEndpoint ?? "",
    requestBody: input.requestBody ?? "",
    upstreamStatus: input.httpStatus,
    elapsedMs: 0,
    rejectReason: input.rejectReason,
  });
}
