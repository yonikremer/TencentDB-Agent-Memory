/**
 * Unique ID generation with business prefixes.
 *
 * Corresponds to design doc §4 ID generation specification (v3.1):
 *   - Subject/resource entity: `{prefix}-{4-char timestamp Base36}{6-char random Base36}` (§4.4 Scheme A)
 *   - Relationship table: UUID v4 (`randomUUID()`)
 */

import { randomUUID } from "node:crypto";

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const BASE = CHARS.length; // 36
const TS_LEN = 4;
const RAND_LEN = 6;

/** @deprecated Relationship tables use UUID in v3.1; keeping constant for old test migration reference. */
export const RELATION_ID_LEN = 36;

/** Business entity ID prefix mapping (relationship tables have no prefix). */
export const ID_PREFIX = {
  user: "usr",
  team: "team",
  agent: "agt",
  task: "task",
  asset: "ast",
  userKey: "uky",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/** Encode non-negative integer to fixed-length Base36 (left-padded with 0). */
function encodeBase36(value: number, length: number): string {
  let out = "";
  let remaining = value;
  for (let i = 0; i < length; i++) {
    out = CHARS[remaining % BASE] + out;
    remaining = Math.floor(remaining / BASE);
  }
  return out;
}

/** Generate random Base36 string of length. */
function randomBase36(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CHARS[Math.floor(Math.random() * BASE)];
  }
  return out;
}

/**
 * Generate entity ID with prefix, e.g. `usr-3mfxa3b9c1`.
 *
 * @param prefix Business prefix (see ID_PREFIX)
 */
export function generateId(prefix: string): string {
  const ts = Math.floor(Date.now() / 1000) % BASE ** TS_LEN;
  const tsPart = encodeBase36(ts, TS_LEN);
  const randPart = randomBase36(RAND_LEN);
  return `${prefix}-${tsPart}${randPart}`;
}

/** Generate relationship table primary key (UUID v4). */
export function generateRelationId(): string {
  return randomUUID();
}

/**
 * Validate ID legality.
 *
 * @param id ID to validate
 * @param prefix Optional, when specified requires ID to start with `{prefix}-`; when omitted only validates non-empty
 *               (compatible with existing ULID format).
 */
export function isValidId(id: string, prefix?: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (prefix === undefined) return id.length > 0;
  return id.startsWith(`${prefix}-`);
}
