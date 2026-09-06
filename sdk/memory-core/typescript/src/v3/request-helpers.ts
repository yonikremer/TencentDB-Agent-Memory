/** Shared KS-plane request helpers (wiki + ops clients). */
import { ParamError } from "../errors.js";

export function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function requireNonEmpty(name: string, value: string | undefined): string {
  if (!value || !value.trim()) throw new ParamError(`requires non-empty ${name}`);
  return value;
}

export interface GraphSearchOptions {
  hop?: number;
  decay?: number;
  minScore?: number;
}

/**
 * Validate wiki /search graph-expansion options against the server contract
 * (wiki.ts: hop int 0..5, decay 0..1, minScore >= 0) and flatten them to the
 * top-level body fields the server actually reads (hop/decay/minScore).
 */
export function flatGraphOptions(graph?: GraphSearchOptions): Record<string, unknown> {
  if (!graph || Object.keys(graph).length === 0) return {};
  const out: Record<string, unknown> = {};
  if (graph.hop !== undefined) {
    if (!Number.isInteger(graph.hop) || graph.hop < 0 || graph.hop > 5) {
      throw new ParamError("search hop must be an integer in 0..5");
    }
    out.hop = graph.hop;
  }
  if (graph.decay !== undefined) {
    if (typeof graph.decay !== "number" || Number.isNaN(graph.decay) || graph.decay < 0 || graph.decay > 1) {
      throw new ParamError("search decay must be a number in 0..1");
    }
    out.decay = graph.decay;
  }
  if (graph.minScore !== undefined) {
    if (typeof graph.minScore !== "number" || Number.isNaN(graph.minScore) || graph.minScore < 0) {
      throw new ParamError("search minScore must be a non-negative number");
    }
    out.minScore = graph.minScore;
  }
  return out;
}
