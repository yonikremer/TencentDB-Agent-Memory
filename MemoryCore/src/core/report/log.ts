/**
 * Log structured logging facade — Debug/Info/Warn/Error
 *
 * Usage:
 *
 *   import { log } from "./core/report/log.js";
 *
 *   log.info("recall completed", { count: 10, latencyMs: 42 });
 *   log.error("embedding failed", { provider: "zhipu", error: err.message });
 *
 * Sends structured logs via ILogBackend underlying (Internal environment: OTel Logs API -> Zhiyan + ClickHouse).
 * Automatically correlates current Trace context (if logging within a Span, Log automatically attaches TraceID/SpanID).
 * Simultaneously writes to local log files (via FileLogger).
 * If backend is not initialized, fallbacks to file + console.
 *
 * Public API signature remains unchanged, callers do not need to modify.
 */

import { FileLogger } from "./file-logger.js";
import { getObservabilityBackend } from "./factory.js";

// Initialize file logger (degradation strategy: initialization failure does not affect business)
const fileLogger = new FileLogger({
  path: process.env.LOG_PATH || "/data/log/",
  filename: "core.log",
  rotateSizeBytes: 100 * 1024 * 1024, // 100MB
  rotateBackupLimit: 10,
});

/**
 * Emit a structured log.
 * Reports via ILogBackend, and simultaneously writes to local file.
 */
function emit(level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, data?: Record<string, unknown>): void {
  try {
    // Build attributes (only accepts primitive types)
    const attrs: Record<string, string | number | boolean> = {};
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined) continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          attrs[key] = value;
        }
      }
    }

    // Report via ILogBackend
    const backend = getObservabilityBackend().log;
    switch (level) {
      case "DEBUG":
        backend.debug?.(message, attrs);
        break;
      case "INFO":
        backend.info(message, attrs);
        break;
      case "WARN":
        backend.warn(message, attrs);
        break;
      case "ERROR":
        backend.error(message, attrs);
        break;
    }

    // Simultaneously write to local log file (regardless of whether backend is available)
    fileLogger.write(level, message, data);
  } catch {
    // Do not block business logic
  }
}

export const log = {
  debug(message: string, data?: Record<string, unknown>): void {
    emit("DEBUG", message, data);
  },

  info(message: string, data?: Record<string, unknown>): void {
    emit("INFO", message, data);
  },

  warn(message: string, data?: Record<string, unknown>): void {
    emit("WARN", message, data);
  },

  error(message: string, data?: Record<string, unknown>): void {
    emit("ERROR", message, data);
  },
};
