import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { LogFields, Logger } from '../../infra/logger.js';

declare module 'hono' {
  interface ContextVariableMap {
    reqId: string;
    log: Logger;
  }
}

/**
 * Access log middleware:
 * - Generate (or pass through) reqId for each request, and write it back to the response header;
 * - Inject ctx.var.log (a sub logger with reqId), so business handlers can use it to log business logs directly;
 * - After the request ends, log by level: 5xx=error / 4xx=warn / 2xx=info (except for noise paths).
 *
 * Noise filtering:
 *   - Static resources (/, /assets/*, /favicon.ico, *.html, etc.) are not logged by default
 *   - /health is frequently probed externally, so only log 4xx/5xx
 *   - Other API paths (/api/v1/*) are logged normally as info (preserve observability)
 */
const STATIC_PREFIXES = ['/assets/', '/favicon'];
const STATIC_EXTS = ['.js', '.css', '.map', '.png', '.svg', '.ico', '.html', '.woff', '.woff2'];

function isStaticAsset(path: string): boolean {
  if (path === '/' ) return true;
  if (STATIC_PREFIXES.some((p) => path.startsWith(p))) return true;
  return STATIC_EXTS.some((ext) => path.endsWith(ext));
}

function isHealthCheck(path: string): boolean {
  return path === '/health';
}

export function requestLogger(logger: Logger) {
  return createMiddleware(async (c, next) => {
    const reqId = c.req.header('x-request-id') ?? randomUUID();
    const start = Date.now();
    const reqLog = logger.child({ reqId });
    c.set('reqId', reqId);
    c.set('log', reqLog);
    c.header('x-request-id', reqId);

    try {
      await next();
    } finally {
      const status = c.res.status;
      const path = c.req.path;
      const isError = status >= 500;
      const isWarn = status >= 400 && status < 500;

      // Noise filtering: neither static resources nor successful health checks log info
      const isNoise = !isError && !isWarn && (isStaticAsset(path) || isHealthCheck(path));
      if (isNoise) return;

      const user = c.get('user');
      const ip = c.req.header('x-forwarded-for');
      const fields: LogFields = {
        method: c.req.method,
        path,
        status,
        durationMs: Date.now() - start,
      };
      if (user) fields.userId = user.user_id;
      if (ip) fields.ip = ip;

      const level = isError ? 'error' : isWarn ? 'warn' : 'info';
      reqLog[level]('request', fields);
    }
  });
}
