/**
 * Unified pagination for metadata list interfaces (offset style).
 *
 * Inputs: limit/offset are optional; defaults to limit=20, offset=0 when not provided.
 * Output: always a PaginatedResult envelope.
 */
import { z } from "zod";
import type {
  ListPage,
  PaginatedResult,
  PaginationInput,
  PaginationParams,
} from "./types.js";

export const DEFAULT_PAGINATION: PaginationParams = { limit: 20, offset: 0 };

/** Optional pagination fields in request body (merged into each list schema, no standalone defaults to avoid Zod merge anomalies). */
export const paginationInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const paginationResolvedSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Parse pagination inputs (uses default 20/0 when limit/offset are missing). */
export function resolvePagination(input?: PaginationInput): PaginationParams {
  return paginationResolvedSchema.parse(input ?? {});
}

/** @deprecated Use resolvePagination */
export function toPaginationParams(input?: PaginationInput): PaginationParams {
  return resolvePagination(input);
}

export function wrapPaginated<T>(
  items: T[],
  total: number,
  pagination: PaginationParams,
): PaginatedResult<T> {
  return {
    items,
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

/** Check if it is a pagination envelope (compatibility for historical bare arrays during Control/SDK parsing). */
export function isPaginatedResult<T>(value: unknown): value is PaginatedResult<T> {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && "items" in value
    && Array.isArray((value as PaginatedResult<T>).items)
    && "total" in value
  );
}

/** Unwrap list response (compatible with PaginatedResult and historical bare arrays T[]). */
export function unwrapListItems<T>(value: T[] | PaginatedResult<T>): T[] {
  return isPaginatedResult(value) ? value.items : value;
}

/** Unified output for list API. */
export function formatListResult<T>(
  page: ListPage<T>,
  pagination: PaginationParams,
): PaginatedResult<T> {
  return wrapPaginated(page.items, page.total, pagination);
}

/** Perform offset pagination on materialized arrays (for permission aggregation scenarios like listAccessibleAssets). */
export function paginateArray<T>(items: T[], pagination: PaginationParams): PaginatedResult<T> {
  const total = items.length;
  const slice = items.slice(pagination.offset, pagination.offset + pagination.limit);
  return wrapPaginated(slice, total, pagination);
}
