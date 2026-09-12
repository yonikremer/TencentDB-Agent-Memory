/** convert.ts — multi-format SourceFile -> RenderedMd (option 2 health: per-conversion probe). No background loop. Ports ingest-pipeline/scripts/convert routing minus OneNote. */
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
export const DOCLING_EXTS = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);
// Legacy OLE binaries convert in-process (pure-JS, no LibreOffice sidecar).
export const LEGACY_EXTS = new Set([".doc", ".xls", ".msg"]);
export const PASS_EXTS = new Set([".md"]);
export const LOCAL_EXTS = new Set([".txt", ".csv", ".html", ".htm", ".eml"]);
// Visio flowcharts render in-process (direct-XML port of fuadmefleh/visio_to_markdown).
export const VSDX_EXTS = new Set([".vsdx"]);
export type Route = "docling" | "passthrough" | "local" | "unsupported";
export function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i).toLowerCase();
}
export function routeFor(filename: string): Route {
  const e = extOf(filename);
  if (DOCLING_EXTS.has(e)) return "docling";
  if (LEGACY_EXTS.has(e)) return "local";
  if (PASS_EXTS.has(e)) return "passthrough";
  if (LOCAL_EXTS.has(e)) return "local";
  if (VSDX_EXTS.has(e)) return "local";
  return "unsupported";
}
export function getDoclingUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.KNOWLEDGE_DOCLING_URL || env.DOCLING_URL || "http://localhost:5001"
  );
}
export function getRawLimits(env: NodeJS.ProcessEnv = process.env): {
  perFile: number;
  total: number;
} {
  const per = Number.parseInt(env.KNOWLEDGE_RAW_MAX_BYTES ?? "", 10);
  const tot = Number.parseInt(env.KNOWLEDGE_RAW_TOTAL_BYTES ?? "", 10);
  return {
    perFile: Number.isInteger(per) && per > 0 ? per : 100 * 1024 * 1024,
    total: Number.isInteger(tot) && tot > 0 ? tot : 50 * 1024 * 1024 * 1024,
  };
}
/** Option 2 probe: GET /health, fallback GET /v1/status/poll/test. True = reachable. Never throws. */
export async function probeDocling(
  baseUrl: string,
  timeoutMs = 1500,
): Promise<boolean> {
  const u = baseUrl.replace(/\/$/, "");
  for (const p of ["/health", "/v1/status/poll/test"]) {
    try {
      const r = await fetchWithTimeout(u + p, {}, timeoutMs);
      if (r.ok) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}
/** Typed failure with HTTP status code. */
export function fail(statusCode: number, message: string): never {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  throw err;
}
export class DoclingDown extends Error {
  statusCode = 503;
  pending: string;
  constructor(pending: string) {
    super("docling server is unreachable");
    this.pending = pending;
  }
}
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}
async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; data: any }> {
  const r = await fetchWithTimeout(url, init, timeoutMs);
  return { status: r.status, data: await r.json() };
}
/** Poll one async task to its result document. Throws on task failure. */
async function pollTask(
  u: string,
  taskId: string,
  timeoutMs: number,
): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const p = await fetchJson(u + "/v1/status/poll/" + taskId, {}, 10000);
    const st = p.data?.status ?? p.data?.task_status;
    if (st === "success" || p.data?.document) {
      return p.data?.document
        ? p.data
        : (await fetchJson(u + "/v1/result/" + taskId, {}, 30000)).data;
    }
    if (st === "failure" || st === "error")
      return fail(
        502,
        "docling task failed: " + JSON.stringify(p.data).slice(0, 200),
      );
  }
  return fail(504, "docling task timed out: " + taskId);
}
/** POST bytes to docling-serve via async tasks (sync 504s on slow OCR). Probe first (option 2). */
export async function convertViaDocling(
  bytes: Uint8Array,
  filename: string,
  baseUrl: string,
  timeoutMs = 300_000,
): Promise<string> {
  const u = baseUrl.replace(/\/$/, "");
  let up = false;
  for (let i = 0; i < 3 && !up; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 5000));
    up = await probeDocling(u, 5000);
  }
  if (!up) throw new DoclingDown(filename);
  const form = () => {
    const f = new FormData();
    f.append("files", new Blob([bytes as any]), filename);
    return f;
  };
  let data: any;
  try {
    // Async first: sync POST 504s on slow OCR jobs; the task API never blocks.
    const a = await fetchJson(
      u + "/v1/convert/file/async",
      { method: "POST", body: form() },
      30000,
    );
    if (a.status === 404) {
      const r = await fetchJson(
        u + "/v1/convert/file",
        { method: "POST", body: form() },
        timeoutMs,
      );
      if (r.status >= 500) throw new DoclingDown(filename);
      data = r.data;
    } else {
      if (a.status >= 500) throw new DoclingDown(filename);
      data = a.data;
    }
  } catch (e) {
    if (e instanceof DoclingDown) throw e;
    throw new DoclingDown(filename);
  }
  if (data?.task_id) data = await pollTask(u, data.task_id, timeoutMs);
  const doc = data?.document ?? {};
  const md =
    [doc.md_content, doc.markdown, doc.text_content].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    ) ?? "";
  if (!md)
    throw new Error(
      `docling empty markdown for ${filename} (status=${data?.status} errors=${JSON.stringify(data?.errors ?? []).slice(0, 300)}): doc keys ` +
        Object.entries(doc)
          .map(([k, v]) => `${k}=${typeof v}`)
          .join(","),
    );
  return md;
}
/** Local renderers, no new deps. */
export function renderLocal(ext: string, text: string): string {
  if (ext === ".csv")
    return (
      "\u0060\u0060\u0060csv\n" +
      text.replace(/\s+$/, "") +
      "\n\u0060\u0060\u0060\n"
    );
  if (ext === ".html" || ext === ".htm")
    return (
      text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim() + "\n"
    );
  if (ext === ".eml") {
    const i = text.search(/\n\n/);
    return (i < 0 ? text : text.slice(i).trim()) + "\n";
  }
  return text;
}
/** Legacy OLE binaries via pure-JS libs (no LibreOffice). */
export async function renderLegacy(
  bytes: Uint8Array,
  ext: string,
): Promise<string> {
  const buf = Buffer.from(bytes);
  if (ext === ".msg") {
    const { default: MsgReader } = await import("@kenjiuno/msgreader");
    const d = new MsgReader(buf).getFileData() as {
      subject?: string;
      senderName?: string;
      senderEmail?: string;
      body?: string;
    };
    const head = [
      "# " + (d.subject ?? "(no subject)").trim(),
      "",
      `From: ${d.senderName ?? ""} <${d.senderEmail ?? ""}>`.trim(),
      "",
    ].join("\n");
    return head + (d.body ?? "").trim() + "\n";
  }
  if (ext === ".xls") {
    const { default: XLSX } = await import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer" });
    return wb.SheetNames.map(
      (n) =>
        "## " +
        n +
        "\n\u0060\u0060\u0060csv\n" +
        XLSX.utils.sheet_to_csv(wb.Sheets[n]).replace(/\s+$/, "") +
        "\n\u0060\u0060\u0060\n",
    ).join("\n");
  }
  const { default: WordExtractor } = await import("word-extractor");
  const doc = await new WordExtractor().extract(buf);
  return (
    (typeof doc.getBody === "function" ? doc.getBody() : String(doc)).trim() +
    "\n"
  );
}
/** Route one SourceFile to markdown. Throws 415 unsupported, 503 docling down. */
export async function convertSourceFile(
  bytes: Uint8Array,
  filename: string,
  opts?: { doclingUrl?: string; timeoutMs?: number },
): Promise<string> {
  const route = routeFor(filename);
  if (route === "passthrough" || route === "local") {
    const ext = extOf(filename);
    if (LEGACY_EXTS.has(ext)) return renderLegacy(bytes, ext);
    if (VSDX_EXTS.has(ext)) {
      const { renderVsdx } = await import("./vsdx.js");
      return renderVsdx(bytes, filename);
    }
    const text = Buffer.from(bytes).toString("utf-8");
    return route === "passthrough" ? text : renderLocal(ext, text);
  }
  if (route === "docling")
    return convertViaDocling(
      bytes,
      filename,
      opts?.doclingUrl ?? getDoclingUrl(),
      opts?.timeoutMs,
    );
  return fail(415, "unsupported format: " + extOf(filename));
}
/** Persist raw SourceFile bytes under <project>/raw/sources with quota teeth (S3). */
export interface SavedSource {
  rawPath: string;
  sha256: string;
  size: number;
}
export function rawSourcesDir(projectPath: string): string {
  return join(projectPath, "raw", "sources");
}
function dirTotalBytes(dir: string): number {
  let total = 0;
  try {
    for (const f of readdirSync(dir)) {
      try {
        total += statSync(join(dir, f)).size;
      } catch {
        /* raced deletion — ignore */
      }
    }
  } catch {
    /* missing dir counts as empty */
  }
  return total;
}
export async function saveSourceFile(
  projectPath: string,
  filename: string,
  bytes: Uint8Array,
  limits = getRawLimits(),
): Promise<SavedSource> {
  const safe = basename(filename).replace(/[^\w.\-()[\] ]+/g, "_");
  if (!safe || routeFor(safe) === "unsupported")
    return fail(415, "unsupported format: " + extOf(filename));
  if (bytes.length > limits.perFile)
    return fail(
      413,
      `file too large: ${safe} (${bytes.length} > ${limits.perFile})`,
    );
  const dir = rawSourcesDir(projectPath);
  if (dirTotalBytes(dir) + bytes.length > limits.total)
    return fail(413, `raw quota exceeded (${limits.total} bytes total)`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, safe), Buffer.from(bytes));
  return {
    rawPath: join(dir, safe),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}
