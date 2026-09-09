import path from "node:path";
import { readFile } from "node:fs/promises";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { requestLogger } from "./middleware/request-logger.js";
import type { PanelDeps } from "../panel-deps.js";
import {
  registerHealthRoutes,
  registerMetaInstanceRoutes,
} from "./routes/meta/instances.js";
import { registerMetaProxyRoutes } from "./routes/meta/proxy.js";
import { registerSkillProxyRoutes } from "./routes/skill/proxy.js";
import { registerChatMemoryRoutes } from "./routes/chat-memory.js";
import { registerTaskRoutes } from "./routes/task.js";
import { registerAgentOverviewRoutes } from "./routes/agent-overview.js";
import { registerAgentLifecycleRoutes } from "./routes/agent-lifecycle.js";
import { registerKnowledgeRoutes } from "./routes/knowledge/index.js";
import { registerGroupyRoutes } from "./routes/groupy.js";
import { registerAssetGrantRoutes } from "./routes/asset-grant.js";

const API_PREFIX = "/api/v1";

/** Path prefixes owned by the client router (see MemoryPanel/web/src/routes). */
const SPA_PREFIXES = [
  "/wiki",
  "/code",
  "/skills",
  "/memory",
  "/team",
  "/guide",
];

/**
 * Whether a path is served by the SPA shell with HTTP 200.
 * Unknown extensionless paths still get the shell (client renders NotFoundPage)
 * but with a truthful HTTP 404 — see the fallback in buildPanelApp.
 */
export function isSpaShellPath(p: string): boolean {
  if (p === "/") return true;
  return SPA_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

export function buildPanelApp(deps: PanelDeps): Hono {
  const app = new Hono();

  app.use("*", requestLogger(deps.logger));

  registerHealthRoutes(app);

  const api = new Hono();
  registerMetaInstanceRoutes(api, deps);
  registerMetaProxyRoutes(api, deps);
  // Skill data plane transparent proxy: /api/v1/skill/* → kernel /v3/skill/*
  registerSkillProxyRoutes(api, deps);
  // Chat Memory panel 3-tab dedicated business routing (12.3 decision exception, see top comment in chat-memory.ts)
  registerChatMemoryRoutes(api, deps);
  // Task aggregation route: task/list + batch task-agent/list returned in one call
  registerTaskRoutes(api, deps);
  registerAgentOverviewRoutes(api, deps);
  // Agent lifecycle business routing: /agent/delete-cascade cascades to clear skills at the control level before archiving
  registerAgentLifecycleRoutes(api, deps);
  registerKnowledgeRoutes(api, deps);
  registerGroupyRoutes(api, deps);
  registerAssetGrantRoutes(api, deps);
  app.route(API_PREFIX, api);

  app.onError((err, c) => {
    deps.logger.error("panel unhandled error", {
      err: err instanceof Error ? err.message : String(err),
      path: c.req.path,
    });
    return c.json(
      {
        code: 500,
        message: "INTERNAL",
        request_id: c.get("reqId") ?? "",
        data: null,
      },
      500,
    );
  });

  const distDir = deps.config.ui.distDir;
  // SPA shell, loaded once for the 404 case below.
  let shellCache: Promise<string> | null = null;
  const loadShell = (): Promise<string> =>
    (shellCache ??= readFile(path.join(distDir, "index.html"), "utf8"));
  app.use("/*", serveStatic({ root: distDir }));
  app.get("*", (c, next) => {
    const p = c.req.path;
    if (p.startsWith("/api/") || p === "/health") return next();
    if (isSpaShellPath(p)) {
      return serveStatic({ path: path.join(distDir, "index.html") })(c, next);
    }
    return loadShell().then((html) => c.html(html, 404));
  });

  return app;
}
