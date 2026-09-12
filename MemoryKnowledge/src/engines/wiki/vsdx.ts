/** vsdx.ts — Visio (.vsdx) to Markdown with Mermaid. Byte-parity port of
 * fuadmefleh/visio_to_markdown, mirroring the `vsdx` object model quirks:
 * - shape list = [synthetic root] + top shapes + top shapes again (the lib
 *   concatenates deprecated `page.shapes` with `child_shapes`/`sub_shapes`)
 * - text = own `<Text>` itertext when the element EXISTS (even when empty),
 *   else master-shape text via Master/MasterShape + masters.xml r:id links
 * - Name/Type always resolve empty here, images never extracted
 * - XML `<Connect>` tags are NOT followed (the lib drops them too)
 */
interface RawShape {
  id: string | null;
  textEl: unknown;
  hasTextEl: boolean;
  masterPageId: string | null;
  masterShapeId: string | null;
  children: RawShape[];
}
interface FlatShape {
  id: string | null;
  text: string;
  children: FlatShape[];
}
/** Mirror lib `_sanitize_mermaid_id`: alnum kept, else `_`, max 50 chars. */
export function sanitizeMermaidId(text: string, shapeId?: string): string {
  if (text) {
    const s = text.replace(/[^\p{L}\p{N}]/gu, "_").slice(0, 50);
    return s || "unknown";
  }
  return shapeId ? `shape_${shapeId}` : "unknown";
}
function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
function iterText(t: unknown, out: string[]): void {
  if (typeof t === "string") {
    out.push(t);
    return;
  }
  if (Array.isArray(t)) {
    t.forEach((x) => iterText(x, out));
    return;
  }
  if (t && typeof t === "object") {
    for (const [k, x] of Object.entries(t as Record<string, unknown>))
      if (k === "#text" || k === "t") iterText(x, out);
  }
}
function parseRaw(n: any, parentMaster: string | null): RawShape {
  return {
    id: n.ID === undefined || n.ID === null ? null : String(n.ID),
    textEl: n.Text,
    hasTextEl: n.Text !== undefined,
    masterPageId:
      n.Master !== undefined && n.Master !== null
        ? String(n.Master)
        : parentMaster,
    masterShapeId:
      n.MasterShape !== undefined && n.MasterShape !== null
        ? String(n.MasterShape)
        : null,
    children: asArray<any>(n.Shapes?.Shape).map((x) =>
      parseRaw(
        x,
        n.Master !== undefined && n.Master !== null
          ? String(n.Master)
          : parentMaster,
      ),
    ),
  };
}
function findById(shapes: FlatShape[], id: string): FlatShape | undefined {
  for (const s of shapes) {
    if (s.id === id) return s;
    const r = findById(s.children, id);
    if (r) return r;
  }
  return undefined;
}
function resolveText(
  s: RawShape,
  masters: Map<string, FlatShape[]>,
  depth: number,
): string {
  if (s.hasTextEl) {
    const out: string[] = [];
    iterText(s.textEl, out);
    return out.join("");
  }
  if (depth > 5 || !s.masterPageId) return "";
  const tops = masters.get(s.masterPageId);
  if (!tops || !tops.length) return "";
  const base = s.masterShapeId
    ? (findById(tops, s.masterShapeId) ?? tops[0])
    : tops[0];
  return base.text;
}
function materialize(
  s: RawShape,
  masters: Map<string, FlatShape[]>,
  depth: number,
): FlatShape {
  return {
    id: s.id,
    text: resolveText(s, masters, depth),
    children: s.children.map((x) => materialize(x, masters, depth)),
  };
}
function materializeMaster(
  n: any,
  masters: Map<string, FlatShape[]>,
): FlatShape {
  const raw = parseRaw(n, null);
  const resolve = (s: RawShape, d: number): FlatShape => ({
    id: s.id,
    text: resolveText(s, masters, d),
    children: s.children.map((x) => resolve(x, d)),
  });
  return resolve(raw, 1);
}
function mermaid(shapes: FlatShape[]): string {
  const lines = ["```mermaid", "graph TD"];
  const seen = new Set<string>();
  for (const s of shapes) {
    if (!s.text || !s.id) continue;
    const nid = sanitizeMermaidId(s.text, s.id);
    if (seen.has(nid)) continue;
    seen.add(nid);
    lines.push(`    ${nid}["${s.text.split('"').join("'")}"]`);
  }
  lines.push("", "    %% Hierarchical structure (inferred)");
  const setup: FlatShape[] = [];
  const staging: FlatShape[] = [];
  const finalization: FlatShape[] = [];
  for (const s of shapes) {
    const t = s.text.toLowerCase();
    if (t.includes("setup") || t.startsWith("0") || t.startsWith("1"))
      setup.push(s);
    else if (t.includes("staging") || t.startsWith("2")) staging.push(s);
    else if (t.includes("finalization") || t.startsWith("3"))
      finalization.push(s);
  }
  const link = (a: FlatShape, b: FlatShape) => {
    if (a.text && b.text)
      lines.push(
        `    ${sanitizeMermaidId(a.text, a.id ?? "")} --> ${sanitizeMermaidId(b.text, b.id ?? "")}`,
      );
  };
  if (setup.length && staging.length) link(setup[0], staging[0]);
  if (staging.length && finalization.length) link(staging[0], finalization[0]);
  lines.push("```");
  return lines.join("\n");
}
/** Render one .vsdx (bytes) to markdown. Layout mirrors the lib exactly. */
export async function renderVsdx(
  bytes: Uint8Array,
  filename: string,
): Promise<string> {
  const { default: AdmZip } = await import("adm-zip");
  const { XMLParser } = await import("fast-xml-parser");
  let zip: InstanceType<typeof AdmZip>;
  try {
    zip = new AdmZip(Buffer.from(bytes));
  } catch {
    const { fail } = await import("./convert.js");
    return fail(400, "invalid vsdx (not a zip): " + filename);
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
  });
  const entry = (p: string) => zip.getEntry(p)?.getData().toString("utf-8");
  const pagesRaw = entry("visio/pages/pages.xml");
  if (!pagesRaw) {
    const { fail } = await import("./convert.js");
    return fail(400, "invalid vsdx (no pages.xml): " + filename);
  }
  const masters = new Map<string, FlatShape[]>();
  try {
    const defs = asArray<any>(
      parser.parse(entry("visio/masters/masters.xml") ?? "").Masters?.Master,
    );
    const rels = asArray<any>(
      parser.parse(entry("visio/masters/_rels/masters.xml.rels") ?? "")
        .Relationships?.Relationship,
    );
    const relById = new Map(
      rels.map((r: any) => [String(r.Id), String(r.Target)]),
    );
    for (const d of defs) {
      const rel = Array.isArray(d?.Rel) ? d.Rel[0] : d?.Rel;
      const target = rel
        ? relById.get(String(rel["r:id"] ?? rel["id"] ?? ""))
        : undefined;
      const raw = target ? entry(`visio/masters/${target}`) : undefined;
      if (d?.ID === undefined || !raw) continue;
      const tops = asArray<any>(
        parser.parse(raw).MasterContents?.Shapes?.Shape,
      );
      masters.set(
        String(d.ID),
        tops.map((x) => materializeMaster(x, masters)),
      );
    }
  } catch {
    /* no masters — no inheritance */
  }
  const pageDefs = asArray<any>(parser.parse(pagesRaw).Pages?.Page);
  const pageFiles = zip
    .getEntries()
    .map((e: any) => e.entryName as string)
    .filter((p) => /^visio\/pages\/page\d+\.xml$/.test(p))
    .sort();
  const md: string[] = [
    `# ${filename}\n`,
    "**Total Images Found**: 0\n",
    `## Pages (${pageDefs.length} total)\n`,
  ];
  pageDefs.forEach((p, i) => {
    const name = String(p.Name ?? `Page-${i + 1}`);
    md.push(`### Page ${i + 1}: ${name}\n`);
    const raw = pageFiles[i] ? entry(pageFiles[i]) : undefined;
    const top: FlatShape[] = raw
      ? asArray<any>(
          (parser.parse(raw) as any).PageContents?.Shapes?.Shape ??
            (parser.parse(raw) as any).Page?.Shapes?.Shape,
        ).map((x) => materialize(parseRaw(x, null), masters, 0))
      : [];
    const root: FlatShape = { id: null, text: "", children: top };
    const shapes = [root, ...top, ...top];
    md.push("#### Diagram\n", mermaid(shapes), "");
    md.push(
      "#### Detailed Shape Information\n",
      `**Total shapes**: ${shapes.length}\n`,
    );
    let num = 0;
    for (const s of shapes) {
      const allSubs = [...s.children, ...s.children];
      const subs = allSubs.filter((x) => x.text);
      if (!(s.text.trim() || allSubs.length)) continue;
      num += 1;
      md.push(`##### Shape ${num}`);
      if (s.text.trim()) md.push(`- **Text**: ${s.text.trim()}`);
      if (s.id !== null) md.push(`- **ID**: ${s.id}`);
      if (allSubs.length) {
        md.push(`- **Sub-shapes**: ${allSubs.length}`);
        for (const sub of subs) md.push(`  - ${sub.text}`);
      }
      md.push("");
    }
    if (num === 0) md.push("*No shapes with content found on this page*\n");
  });
  return md.join("\n");
}
