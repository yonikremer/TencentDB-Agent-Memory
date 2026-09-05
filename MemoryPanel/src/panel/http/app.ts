import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { requestLogger } from './middleware/request-logger.js';
import type { PanelDeps } from '../panel-deps.js';
import { registerHealthRoutes, registerMetaInstanceRoutes } from './routes/meta/instances.js';
import { registerMetaProxyRoutes } from './routes/meta/proxy.js';
import { registerSkillProxyRoutes } from './routes/skill/proxy.js';
import { registerChatMemoryRoutes } from './routes/chat-memory.js';
import { registerTaskRoutes } from './routes/task.js';
import { registerAgentOverviewRoutes } from './routes/agent-overview.js';
import { registerAgentLifecycleRoutes } from './routes/agent-lifecycle.js';
import { registerKnowledgeRoutes } from './routes/knowledge/index.js';

const API_PREFIX = '/api/v1';

export function buildPanelApp(deps: PanelDeps): Hono {
  const app = new Hono();

  app.use('*', requestLogger(deps.logger));

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
  app.route(API_PREFIX, api);

  app.onError((err, c) => {
    deps.logger.error('panel unhandled error', {
      err: err instanceof Error ? err.message : String(err),
      path: c.req.path,
    });
    return c.json(
      { code: 500, message: 'INTERNAL', request_id: c.get('reqId') ?? '', data: null },
      500,
    );
  });

  const distDir = deps.config.ui.distDir;
  app.use('/*', serveStatic({ root: distDir }));
  app.get('*', (c, next) => {
    const p = c.req.path;
    if (p.startsWith('/api/') || p === '/health') return next();
    return serveStatic({ path: path.join(distDir, 'index.html') })(c, next);
  });

  return app;
}
