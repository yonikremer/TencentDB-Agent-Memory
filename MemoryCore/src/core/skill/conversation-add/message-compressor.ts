/**
 * SkillMessageCompressor — compress oversized tool_call / tool_result payloads
 * before they enter the skill buffer.
 *
 * Corresponds to design doc `2026-07-15-skill-trigger-in-core-design.md` §6:
 *   - Only compresses tool_call / tool_result; user / assistant / system are never compressed
 *   - Content is only compressed when byte count > 2KB: head 1KB + tail 1KB + middle placeholder
 *   - metadata.truncated = true, metadata.original_bytes = <original byte count>
 *
 * Byte-splitting implementation note:
 *   Slicing a Buffer directly may cut in the middle of a UTF-8 multi-byte character,
 *   resulting in U+FFFD replacement characters when converting back to string.
 *   We slice the Buffer and then call toString('utf8'), where Node will replace
 *   incomplete multi-byte sequences at the boundary with U+FFFD — but this does not
 *   affect the downstream LLM review semantics (the prompt indicates truncation).
 *   For tool payloads which are typically ASCII/JSON, boundary character corruption
 *   is extremely rare; tests use relaxed assertions accordingly.
 */

export type CompressibleRole =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "system";

export interface CompressibleMessage {
  role: CompressibleRole;
  content: string;
  /** Optional tool identity for tool_call / tool_result. */
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface CompressOptions {
  /** Byte threshold; tool message content is only compressed when bytes > threshold. Default 2048 (2KB). */
  toolContentThresholdBytes: number;
  /** Head bytes to keep. Default 1024 (1KB). */
  headBytes: number;
  /** Tail bytes to keep. Default 1024 (1KB). */
  tailBytes: number;
  /** Middle placeholder string. */
  placeholder: string;
}

export const DEFAULT_COMPRESS_OPTIONS: CompressOptions = {
  toolContentThresholdBytes: 2048,
  headBytes: 1024,
  tailBytes: 1024,
  placeholder: "\n\n[Middle content too large and has been compressed — only head and tail shown]\n\n",
};

const COMPRESSIBLE_ROLES = new Set<CompressibleRole>(["tool_call", "tool_result"]);

/**
 * Compress a single message. Returns a new object if compressed, otherwise
 * returns the original message reference unchanged.
 */
export function compressMessage(
  msg: CompressibleMessage,
  optsOverride: Partial<CompressOptions> = {},
): CompressibleMessage {
  const opts: CompressOptions = { ...DEFAULT_COMPRESS_OPTIONS, ...optsOverride };
  if (!COMPRESSIBLE_ROLES.has(msg.role)) return msg;

  const bytes = Buffer.byteLength(msg.content, "utf8");
  if (bytes <= opts.toolContentThresholdBytes) return msg;

  const buf = Buffer.from(msg.content, "utf8");
  const head = buf.subarray(0, opts.headBytes).toString("utf8");
  const tail = buf.subarray(buf.length - opts.tailBytes).toString("utf8");

  const nextContent = `${head}${opts.placeholder}${tail}`;
  const nextMetadata: Record<string, unknown> = {
    ...(msg.metadata ?? {}),
    truncated: true,
    original_bytes: bytes,
  };

  return {
    ...msg,
    content: nextContent,
    metadata: nextMetadata,
  };
}

/**
 * Compress an array of messages. Returns a new array; unchanged messages
 * share the original reference (identity-preserving for downstream diffing).
 */
export function compressMessages(
  messages: CompressibleMessage[],
  optsOverride: Partial<CompressOptions> = {},
): CompressibleMessage[] {
  if (messages.length === 0) return [];
  return messages.map((m) => compressMessage(m, optsOverride));
}
