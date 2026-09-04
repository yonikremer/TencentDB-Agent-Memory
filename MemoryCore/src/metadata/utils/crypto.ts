/**
 * User key and password hashing utilities.
 *
 * Corresponds to design doc §5:
 *   - user_key: `sk-mem-` prefix + 24 byte(192bit) base64url random segment, external caller auth identifier
 *   - password: scrypt + per-user random salt + global pepper (irreversible hash)
 *
 * pepper is injected via environment variable during deployment (see loadPasswordHashConfig).
 * From v3.1, metadata User domain no longer uses password hash; this module only retains generateUserKey and legacy hash tools.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { USER_KEY_PREFIX } from "./user-key.js";

/**
 * Generate user key: `sk-mem-` prefix + 24 byte(192bit) base64url random segment.
 *
 * base64url charset is `[A-Za-z0-9_-]`, safe for URL / HTTP Header / JSON.
 * 192bit entropy is far above collision boundary, global uniqueness guaranteed with `key_value` unique index.
 */
export function generateUserKey(): string {
  return USER_KEY_PREFIX + randomBytes(24).toString("base64url");
}

const PASSWORD_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";

/** Generate random password (default 12 chars, charset: alphanumeric, underscore). */
export function generatePassword(length = 12): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_CHARSET[bytes[i]! % PASSWORD_CHARSET.length];
  }
  return out;
}

/** scrypt parameters and DB storage format prefix. */
export const PASSWORD_HASH_PREFIX = "$scrypt$";
const SALT_LEN = 16;
const DEFAULT_SCRYPT_N = 16384;
const DEFAULT_SCRYPT_R = 8;
const DEFAULT_SCRYPT_P = 1;
const DEFAULT_SCRYPT_KEYLEN = 32;
const PEPPER_LEN = 32;

export interface PasswordHashConfig {
  pepper: Buffer;
  scryptN: number;
  scryptR: number;
  scryptP: number;
  keylen: number;
}

/**
 * Load password hash config from environment variables.
 *
 * Environment variables:
 *   - TDAI_PASSWORD_PEPPER — base64 encoded 32 byte random value (required in service mode)
 *   - TDAI_PASSWORD_SCRYPT_N / _R / _P / _KEYLEN — optional scrypt parameters
 *
 * @throws Throws exception when pepper is not configured or format is invalid.
 */
export function loadPasswordHashConfig(env: NodeJS.ProcessEnv = process.env): PasswordHashConfig {
  const pepperB64 = env.TDAI_PASSWORD_PEPPER?.trim();
  if (!pepperB64) {
    throw new Error("TDAI_PASSWORD_PEPPER is not configured (base64-encoded 32-byte secret required)");
  }
  const pepper = Buffer.from(pepperB64, "base64");
  if (pepper.length !== PEPPER_LEN) {
    throw new Error(
      `TDAI_PASSWORD_PEPPER must decode to ${PEPPER_LEN} bytes, got ${pepper.length}`,
    );
  }

  const scryptN = parsePositiveInt(env.TDAI_PASSWORD_SCRYPT_N, DEFAULT_SCRYPT_N);
  const scryptR = parsePositiveInt(env.TDAI_PASSWORD_SCRYPT_R, DEFAULT_SCRYPT_R);
  const scryptP = parsePositiveInt(env.TDAI_PASSWORD_SCRYPT_P, DEFAULT_SCRYPT_P);
  const keylen = parsePositiveInt(env.TDAI_PASSWORD_SCRYPT_KEYLEN, DEFAULT_SCRYPT_KEYLEN);

  return { pepper, scryptN, scryptR, scryptP, keylen };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid scrypt parameter: ${raw}`);
  }
  return n;
}

function scryptHash(plain: string, salt: Buffer, config: PasswordHashConfig): Buffer {
  const input = Buffer.concat([config.pepper, Buffer.from(plain, "utf8")]);
  return scryptSync(input, salt, config.keylen, {
    N: config.scryptN,
    r: config.scryptR,
    p: config.scryptP,
  });
}

/**
 * Perform scrypt+pepper hash on plaintext password, returning self-describing string for DB storage.
 *
 * Format: `$scrypt$N,r,p$<salt_b64>$<hash_b64>`
 */
export function hashPassword(plain: string, config: PasswordHashConfig): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptHash(plain, salt, config);
  return (
    `${PASSWORD_HASH_PREFIX}${config.scryptN},${config.scryptR},${config.scryptP}` +
    `$${salt.toString("base64url")}$${hash.toString("base64url")}`
  );
}

/** Check if DB storage string is in scrypt hash format. */
export function isPasswordHash(stored: string): boolean {
  return stored.startsWith(PASSWORD_HASH_PREFIX);
}

/**
 * Verify if plaintext password matches DB storage hash. Invalid format or mismatched parameters return false (no exception thrown).
 */
export function verifyPasswordHash(
  plain: string,
  stored: string,
  config: PasswordHashConfig,
): boolean {
  try {
    if (!isPasswordHash(stored)) return false;

    const body = stored.slice(PASSWORD_HASH_PREFIX.length);
    const firstSep = body.indexOf("$");
    if (firstSep < 0) return false;

    const params = body.slice(0, firstSep).split(",");
    if (params.length !== 3) return false;
    const [nStr, rStr, pStr] = params;
    const n = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

    const rest = body.slice(firstSep + 1);
    const secondSep = rest.indexOf("$");
    if (secondSep < 0) return false;

    const salt = Buffer.from(rest.slice(0, secondSep), "base64url");
    const expectedHash = Buffer.from(rest.slice(secondSep + 1), "base64url");

    const verifyConfig: PasswordHashConfig = {
      ...config,
      scryptN: n,
      scryptR: r,
      scryptP: p,
      keylen: expectedHash.length,
    };
    const actualHash = scryptHash(plain, salt, verifyConfig);
    if (actualHash.length !== expectedHash.length) return false;
    return timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}
