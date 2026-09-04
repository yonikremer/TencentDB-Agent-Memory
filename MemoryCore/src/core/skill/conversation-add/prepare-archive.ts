/**
 * prepareArchivePayload — shared "compress + fallback" archive payload assembly
 * used by direct-trigger (`/v3/skill/extract`) and the conversation-add handler.
 *
 * Extracted here so both paths share **a single implementation**, preventing subtle drift.
 *
 * Steps (equivalent logic from the §③ branching section inside `add-handler.ts` handle()):
 *   ① forceCompress=true → compressMessages(incoming); otherwise passthrough
 *   ② combined = existing + compressed
 *   ③ Only when forceCompress=true and totalBytes(combined) > chunkMax
 *      → applyOversizeStrategy (fallback truncation only on compression path, matching original add-handler behavior)
 *   ④ Return { messages, usedCompress, usedOversize }
 *
 * Calling convention:
 *   - conversation/add: existing = data-current, forceCompress = (rawBytes >= threshold)
 *   - skill_extract  : existing = [], forceCompress = true (direct-trigger always compresses)
 */

import {
  compressMessages,
  type CompressOptions,
  type CompressibleMessage,
} from "./message-compressor.js";
import {
  applyOversizeStrategy,
  type OversizeMessage,
  type OversizeOptions,
} from "./oversize-strategy.js";

export interface PrepareArchiveOptions {
  compress: CompressOptions;
  oversize: OversizeOptions;
  /** Always true for direct-trigger; only true on the compression path for conversation/add. */
  forceCompress: boolean;
}

export interface PrepareArchiveResult {
  messages: OversizeMessage[];
  /** Whether compressMessages was applied (true only when some tool message exceeded the threshold). */
  usedCompress: boolean;
  /** Whether oversize fallback truncation was triggered. */
  usedOversize: boolean;
}

export function prepareArchivePayload(
  existing: OversizeMessage[],
  incoming: CompressibleMessage[],
  opts: PrepareArchiveOptions,
): PrepareArchiveResult {
  // ① forceCompress determines whether to apply compression
  const compressed: CompressibleMessage[] = opts.forceCompress
    ? compressMessages(incoming, opts.compress)
    : incoming;

  // usedCompress reflects "was any content actually compressed" — not "was forceCompress set".
  // compressMessages only modifies content when tool message content > threshold;
  // short messages return identity even with forceCompress, so they don't count as truly compressed.
  const usedCompress = opts.forceCompress && compressed.some(
    (m, i) => m !== incoming[i],
  );

  // ② Concatenate
  const combined: OversizeMessage[] = [
    ...existing,
    ...(compressed as unknown as OversizeMessage[]),
  ];

  // ③ Check if oversize fallback is needed — only triggered on the forceCompress path, matching
  //    original add-handler behavior (normal path won't combined > chunkMax; only after strong
  //    compression still exceeds limit does fallback kick in). skill_extract forceCompress=true,
  //    so this check naturally applies.
  if (!opts.forceCompress) {
    return { messages: combined, usedCompress, usedOversize: false };
  }
  const combinedBytes = totalMessagesBytes(combined);
  if (combinedBytes <= opts.oversize.chunkMaxBytes) {
    return { messages: combined, usedCompress, usedOversize: false };
  }

  const out = applyOversizeStrategy(combined, opts.oversize);
  return {
    messages: out.messages,
    usedCompress,
    usedOversize: out.truncated,
  };
}

function totalMessagesBytes(msgs: Array<{ role: string; content: string }>): number {
  let sum = 0;
  for (const m of msgs) sum += Buffer.byteLength(JSON.stringify(m), "utf8");
  return sum;
}
