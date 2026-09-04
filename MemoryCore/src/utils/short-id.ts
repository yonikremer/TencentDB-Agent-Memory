/**
 * short-id — Short ID generator based on CSPRNG + base62
 *
 * Why not use Math.random().toString(36):
 *   - Math.random() is pseudo-random (V8 xorshift128+), returned double mantissa has only 52 bits
 *   - Multi-process has no seed isolation, multiple replicas starting in the same second may have correlated leading bits
 *   - base36 encoded 12 characters looks like 62 bits space, but limited by 52 bit entropy,
 *     collision probability at 1 million skills in a single instance is about 1.1e-4 (birthday paradox, not engineering acceptable)
 *
 * This utility uses `crypto.randomBytes` (CSPRNG) + base62 encoding:
 *   - base62 = 0-9 A-Z a-z, pure alphanumeric, no special symbols (URL/COS/log friendly)
 *   - 12 character base62 = 62^12 ≈ 3.23e21 space ≈ 71 bits true entropy
 *   - collision probability at 1 million entries ≈ 1.5e-10, reduced by about 730k times compared to current status
 *
 * Used for:
 *   - SkillCore generating skill_id (`skl-` + 12 chars = 16 chars, same length as today)
 *   - SqliteSkillStore / TcvdbSkillStore generating row_id
 */

import { randomBytes } from "node:crypto";

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Rejection sampling threshold: 256 divided by 62 floor * 62 = 248
// Byte values 0..247 uniformly map to 62 characters; 248..255 are discarded to avoid modulo bias.
const REJECTION_THRESHOLD = 248;

/**
 * Generate a base62 random string of specified length (CSPRNG entropy).
 *
 * @param len Output character count (>=1)
 */
export function randomBase62(len: number): string {
  if (!Number.isInteger(len) || len < 1) {
    throw new RangeError(`randomBase62: len must be a positive integer, got ${len}`);
  }
  let out = "";
  while (out.length < len) {
    // How many bytes needed: estimate (remaining length * 256/248) ceil + small redundancy
    const remaining = len - out.length;
    const need = Math.max(8, Math.ceil((remaining * 256) / REJECTION_THRESHOLD) + 4);
    const buf = randomBytes(need);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const b = buf[i];
      if (b < REJECTION_THRESHOLD) {
        out += BASE62_ALPHABET[b % 62];
      }
    }
  }
  return out;
}
