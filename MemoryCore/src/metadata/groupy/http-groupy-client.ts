/**
 * Org-hierarchy-sync — real groupy HTTP adapter.
 *
 * ASSUMED contract (DESIGN §13 open fact — swap this adapter when the real
 * company-net facts land; the pipeline above it does not change):
 *   GET {baseUrl}/node/{id}  Authorization: Bearer {token}
 *   → { id, name?, display_name?|displayName?, members: [{ id, kind }] }
 * Field parsing is tolerant; member kind must be user|org.
 * GROUPY_TOKEN is sent as a header only and never logged.
 */

import { GroupyClient, type GroupyNodeData } from "./groupy-client.js";

export class HttpGroupyClient extends GroupyClient {
  private readonly root: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 15_000,
  ) {
    super();
    if (!baseUrl) throw new Error("groupy http client requires GROUPY_BASE_URL");
    this.root = baseUrl.replace(/\/+$/, "");
  }

  async fetchNode(id: string): Promise<GroupyNodeData> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const resp = await fetch(`${this.root}/node/${encodeURIComponent(id)}`, {
        headers,
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`groupy fetch failed: ${id}: HTTP ${resp.status}`);
      return normalizeGroupyNode(await resp.json());
    } catch (err) {
      if (err instanceof Error && /groupy fetch failed|malformed/.test(err.message)) throw err;
      throw new Error(`groupy fetch failed: ${id}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Tolerant shape normalization (also used to validate mock fixtures loosely). */
export function normalizeGroupyNode(body: unknown): GroupyNodeData {
  const b = body as Record<string, unknown>;
  if (!b || typeof b.id !== "string" || !b.id) {
    throw new Error("groupy node malformed: missing string id");
  }
  const display =
    typeof b.display_name === "string" ? b.display_name
    : typeof b.displayName === "string" ? b.displayName
    : typeof b.name === "string" ? b.name
    : b.id;
  if (!Array.isArray(b.members)) {
    throw new Error(`groupy node malformed: ${b.id}: missing members[]`);
  }
  const members = (b.members as Array<Record<string, unknown>>).map((m) => {
    if (typeof m?.id !== "string" || (m.kind !== "user" && m.kind !== "org")) {
      throw new Error(`groupy node malformed: ${b.id}: bad member ref`);
    }
    return { id: m.id as string, kind: m.kind as "user" | "org" };
  });
  return {
    id: b.id,
    name: typeof b.name === "string" ? b.name : b.id,
    display_name: display,
    members,
  };
}
