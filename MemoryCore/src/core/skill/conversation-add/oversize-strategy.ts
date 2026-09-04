/**
 * SkillOversizeStrategy — fallback chunking for oversized messages.
 *
 * Corresponds to design doc `2026-07-15-skill-trigger-in-core-design.md` §8.
 *
 * Trigger condition:
 *   On the compression path, after compression the current messages + existing data-current content
 *   still exceeds chunkMax.
 *
 * Strategy:
 *   Accumulate from the head up to the headKeepBytes boundary (split on message boundaries
 *   to ensure valid JSONL)
 *   Accumulate from the tail up to the tailKeepBytes boundary
 *   All messages in between → replaced by a single role=system placeholder message
 *
 * Edge case: a single message exceeds the head/tail budget → allow 1 message each for head and tail
 * (guarantees at least head + tail messages are present).
 */

export interface OversizeMessage {
  role: string;
  content: string;
  // Allow pass-through of other fields
  [key: string]: unknown;
  metadata?: Record<string, unknown>;
}

export interface OversizeOptions {
  chunkMaxBytes: number;
  headKeepBytes: number;
  tailKeepBytes: number;
  /** Placeholder content template; `{n}` is replaced with the omitted count, `{bytes}` with the omitted byte count. */
  placeholderTemplate: string;
}

export const DEFAULT_OVERSIZE_OPTIONS: OversizeOptions = {
  chunkMaxBytes: 81_920, // 80KB
  headKeepBytes: 20_480, // 20KB
  tailKeepBytes: 20_480, // 20KB
  placeholderTemplate: "[{n} middle messages / {bytes} bytes omitted — content too large]",
};

export interface OversizeResult {
  /** The processed message sequence */
  messages: OversizeMessage[];
  /** Whether truncation was triggered (false means direct passthrough) */
  truncated: boolean;
  /** Number of omitted messages */
  omittedMessageCount: number;
  /** Number of omitted bytes */
  omittedBytes: number;
}

function messageBytes(msg: OversizeMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), "utf8");
}

function totalBytes(msgs: OversizeMessage[]): number {
  let sum = 0;
  for (const m of msgs) sum += messageBytes(m);
  return sum;
}

export function applyOversizeStrategy(
  messages: OversizeMessage[],
  optsOverride: Partial<OversizeOptions> = {},
): OversizeResult {
  const opts: OversizeOptions = { ...DEFAULT_OVERSIZE_OPTIONS, ...optsOverride };

  if (messages.length === 0) {
    return { messages: [], truncated: false, omittedMessageCount: 0, omittedBytes: 0 };
  }

  const total = totalBytes(messages);
  if (total <= opts.chunkMaxBytes) {
    return { messages: [...messages], truncated: false, omittedMessageCount: 0, omittedBytes: 0 };
  }

  // Accumulate from the head
  const headMsgs: OversizeMessage[] = [];
  let headBytes = 0;
  let headEnd = 0; // exclusive
  for (let i = 0; i < messages.length; i++) {
    const b = messageBytes(messages[i]!);
    // Allow at least 1 message in head (fallback for extreme single message > headKeep)
    if (headMsgs.length > 0 && headBytes + b > opts.headKeepBytes) break;
    headMsgs.push(messages[i]!);
    headBytes += b;
    headEnd = i + 1;
    if (headBytes >= opts.headKeepBytes) break;
  }

  // Accumulate from the tail (don't overlap with head region)
  const tailMsgs: OversizeMessage[] = [];
  let tailBytes = 0;
  let tailStart = messages.length; // inclusive
  for (let i = messages.length - 1; i >= headEnd; i--) {
    const b = messageBytes(messages[i]!);
    if (tailMsgs.length > 0 && tailBytes + b > opts.tailKeepBytes) break;
    tailMsgs.unshift(messages[i]!);
    tailBytes += b;
    tailStart = i;
    if (tailBytes >= opts.tailKeepBytes) break;
  }

  // Omitted segment between head and tail
  const omittedSlice = messages.slice(headEnd, tailStart);
  const omittedMessageCount = omittedSlice.length;
  const omittedBytes = totalBytes(omittedSlice);

  // Edge case: head + tail covers everything (omitted=0) → treat as passthrough
  if (omittedMessageCount === 0) {
    return {
      messages: [...messages],
      truncated: false,
      omittedMessageCount: 0,
      omittedBytes: 0,
    };
  }

  const placeholderContent = opts.placeholderTemplate
    .replace("{n}", String(omittedMessageCount))
    .replace("{bytes}", String(omittedBytes));

  const placeholder: OversizeMessage = {
    role: "system",
    content: placeholderContent,
    metadata: {
      omitted_message_count: omittedMessageCount,
      omitted_bytes: omittedBytes,
    },
  };

  return {
    messages: [...headMsgs, placeholder, ...tailMsgs],
    truncated: true,
    omittedMessageCount,
    omittedBytes,
  };
}
