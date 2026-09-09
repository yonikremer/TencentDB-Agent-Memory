/**
 * ui-spa-fallback.test.ts — SPA shell serving with truthful HTTP status.
 *
 * Client-router paths (/, /wiki/:id/..., /code/..., /skills/..., /memory/...,
 * /team/..., /guide) get index.html with 200 so refresh/deep links work.
 * Unknown paths still get the shell (client renders NotFoundPage) but with
 * a literal HTTP 404. API routes are untouched by the fallback.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPanelApp, isSpaShellPath } from "../src/panel/http/app.js";
import { InstanceRegistry } from "../src/panel/config/instance-registry.js";
import { KnowledgeTaskRegistry } from "../src/panel/state/knowledge-task-registry.js";
import { IngestProgressStore } from "../src/panel/state/ingest-progress-store.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";
import type { PanelConfig } from "../src/panel/config/panel-config.js";
import type { Logger } from "../src/panel/infra/logger.js";

const SHELL = "<html><body>spa-shell-marker</body></html>";

let tmp = "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "spa-fallback-"));
  writeFileSync(join(tmp, "index.html"), SHELL);
  const deps = {
    config: { ui: { distDir: tmp } } as PanelConfig,
    logger: nullLogger,
    instanceRegistry: new InstanceRegistry([]),
    kernelHttp: {},
    metaKernel: {},
    knowledgeClientFactory: () => ({}),
    skillKernel: {},
    knowledgeTaskRegistry: new KnowledgeTaskRegistry(),
    ingestProgressStore: new IngestProgressStore(),
  } as unknown as PanelDeps;
  app = buildPanelApp(deps);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("isSpaShellPath", () => {
  it.each([
    "/",
    "/wiki",
    "/wiki/abc/overview",
    "/code/c1",
    "/skills/s9",
    "/memory/b1/L2",
    "/team/agents",
    "/guide",
  ])("treats %s as a client route", (p) =>
    expect(isSpaShellPath(p)).toBe(true),
  );
  it.each(["/totally-bogus", "/wiki2", "/codes", "/api/v1/meta/instances"])(
    "rejects %s",
    (p) => expect(isSpaShellPath(p)).toBe(false),
  );
});

describe("SPA fallback status", () => {
  it("serves deep links with 200", async () => {
    for (const p of ["/", "/wiki", "/wiki/abc123/overview", "/memory/b1/L2"]) {
      const res = await app.request(p);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("spa-shell-marker");
    }
  });

  it("serves unknown paths with a real HTTP 404", async () => {
    const res = await app.request("/totally-bogus");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("spa-shell-marker");
  });
});
