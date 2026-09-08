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

/** Fail-safe: a single node beyond this is a malformed/cyclic feed. */
export const MAX_NODE_MEMBERS = 5000;

export class HttpGroupyClient extends GroupyClient {
  private readonly root: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 15_000,
  ) {
    super();
    if (!baseUrl) throw new Error("groupy http client requires GROUPY_BASE_URL");
    // SSRF guard: corpnet HTTPS/HTTP only, no file/unix-socket schemes.
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error("GROUPY_BASE_URL must start with http:// or https://");
    }
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
  if (b.members.length > MAX_NODE_MEMBERS) {
    throw new Error(`groupy node malformed: ${b.id}: members exceed ${MAX_NODE_MEMBERS}`);
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
