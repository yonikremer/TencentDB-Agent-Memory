/**
 * Grants Routes — org-hierarchy-sync share mirror (PLAN P3).
 *
 *   POST /grants/set   {kind, knowledge_id, grants: [{team_id, grant_type?}]} (default viewer)
 *   POST /grants/clear {kind, knowledge_id, team_ids?} (all rows when omitted)
 *
 * Service-scoped by x-tdai-service-id (Panel/admin plane). List/tools queries
 * transparently union owner-team + grant rows — no new request fields.
 *
 * Routes are defined WITHOUT /v3 prefix — prefix applied at server.ts mount level.
 */

import { Hono } from "hono";

import type { WikiService, CodeGraphService } from "../store/index.js";
import { wrapOk, wrapError, isValidIdSegment } from "../api-helpers.js";
import type { GrantType, SetGrantInput } from "../store/types.js";

export interface GrantsRouteDeps {
  wikiService: WikiService;
  cgService: CodeGraphService;
}

type GrantKind = "wiki" | "code-graph";

const GRANT_TYPES: GrantType[] = ["viewer", "editor", "owner"];
const MAX_GRANTS = 100;

/** Optional requester team for grant enforcement on id-only mutation routes. */
export function extractRequesterTeam(body: Record<string, unknown>): { team?: string; invalid: boolean } {
  const t = body.team_id;
  if (t === undefined) return { invalid: false };
  if (!isValidIdSegment(t)) return { invalid: true };
  return { team: t as string, invalid: false };
}

export function createGrantsRoutes(deps: GrantsRouteDeps): Hono {
  const app = new Hono();
  const { wikiService, cgService } = deps;

  function resourceExists(kind: GrantKind, serviceId: string, knowledgeId: string): boolean {
    return kind === "wiki"
      ? wikiService.getById(serviceId, knowledgeId) !== null
      : cgService.getById(serviceId, knowledgeId) !== null;
  }

  function notFound(kind: GrantKind): string {
    return kind === "wiki" ? "wiki not found" : "code graph not found";
  }

  // ── POST /grants/set ──
  app.post("/set", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const kind = body.kind;
    if (kind !== "wiki" && kind !== "code-graph") {
      return c.json(wrapError(400, "kind must be 'wiki' or 'code-graph'"), 400);
    }
    const knowledgeId = body.knowledge_id;
    if (!isValidIdSegment(knowledgeId)) return c.json(wrapError(400, "knowledge_id is required"), 400);
    const rawGrants = body.grants;
    if (!Array.isArray(rawGrants) || rawGrants.length === 0) {
      return c.json(wrapError(400, "grants is required (non-empty array)"), 400);
    }
    if (rawGrants.length > MAX_GRANTS) {
      return c.json(wrapError(400, `grants exceeds max ${MAX_GRANTS}`), 400);
    }
    const grants: SetGrantInput[] = [];
    for (const g of rawGrants) {
      const r = g as Record<string, unknown>;
      if (!isValidIdSegment(r.team_id)) return c.json(wrapError(400, "grants[].team_id is required"), 400);
      const grantType = r.grant_type ?? "viewer";
      if (!GRANT_TYPES.includes(grantType as GrantType)) {
        return c.json(wrapError(400, "grant_type must be viewer|editor|owner"), 400);
      }
      grants.push({ team_id: r.team_id as string, grant_type: grantType as GrantType });
    }
    if (!resourceExists(kind, serviceId as string, knowledgeId as string)) {
      return c.json(wrapError(404, notFound(kind)), 404);
    }
    const rows = kind === "wiki"
      ? wikiService.setGrants(serviceId as string, knowledgeId as string, grants)
      : cgService.setGrants(serviceId as string, knowledgeId as string, grants);
    return c.json(wrapOk({ kind, knowledge_id: knowledgeId, grants: rows }));
  });

  // ── POST /grants/clear ──
  app.post("/clear", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const kind = body.kind;
    if (kind !== "wiki" && kind !== "code-graph") {
      return c.json(wrapError(400, "kind must be 'wiki' or 'code-graph'"), 400);
    }
    const knowledgeId = body.knowledge_id;
    if (!isValidIdSegment(knowledgeId)) return c.json(wrapError(400, "knowledge_id is required"), 400);
    let teamIds: string[] | undefined;
    if (body.team_ids !== undefined) {
      if (!Array.isArray(body.team_ids) || !body.team_ids.every(isValidIdSegment)) {
        return c.json(wrapError(400, "team_ids must be string[]"), 400);
      }
      teamIds = body.team_ids as string[];
    }
    if (!resourceExists(kind, serviceId as string, knowledgeId as string)) {
      return c.json(wrapError(404, notFound(kind)), 404);
    }
    const cleared = kind === "wiki"
      ? wikiService.clearGrants(serviceId as string, knowledgeId as string, teamIds)
      : cgService.clearGrants(serviceId as string, knowledgeId as string, teamIds);
    return c.json(wrapOk({ kind, knowledge_id: knowledgeId, cleared }));
  });

  return app;
}
