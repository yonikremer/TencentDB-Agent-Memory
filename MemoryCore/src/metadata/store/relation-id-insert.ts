/**
 * Insertion for relation table `id` column: collision detection and retry (used with generateRelationId).
 */
import { generateRelationId } from "../utils/id-generator.js";

export const RELATION_ID_RETRY_LIMIT = 3;

/** SQLite: Relation table primary key `id` unique constraint collision. */
export function isSqliteRelationIdCollision(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: meta_\w+\.id\b/.test(msg);
}

/** MongoDB: Relation table primary key `id` duplicate key (E11000). */
export function isMongoRelationIdCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  return e.code === 11000 && Boolean(e.keyPattern?.id);
}

/**
 * Executes insertion using an automatically generated relation id; does not retry when `fixedId` is specified.
 */
export function runWithGeneratedRelationId<T>(
  fixedId: string | undefined,
  isCollision: (err: unknown) => boolean,
  insert: (id: string) => T,
): T {
  if (fixedId) return insert(fixedId);
  let lastErr: unknown;
  for (let attempt = 0; attempt < RELATION_ID_RETRY_LIMIT; attempt++) {
    try {
      return insert(generateRelationId());
    } catch (err) {
      if (isCollision(err)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new Error("relation id collision after max retries");
}
