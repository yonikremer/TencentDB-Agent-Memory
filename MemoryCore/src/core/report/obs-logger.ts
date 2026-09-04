/**
 * Core structured logging facade — based on ILogBackend abstraction
 *
 * Provides info/warn/error methods, automatically correlates current Trace Context,
 * logs are reported via ILogBackend backend (Internal environment: Zhiyan + ClickHouse).
 *
 * Usage:
 *   import { obsLogger } from "../core/report/obs-logger.js";
 *   obsLogger.error("core.llm.timeout", { instance_id: "xxx", session_id: "yyy" });
 *
 * Does not modify any business code, pure observability component.
 * All exceptions do not affect business startup and service flows.
 * Simultaneously writes to local log files (via FileLogger).
 *
 * Public API signature remains unchanged, callers do not need to modify.
 */

import { FileLogger } from "./file-logger.js";
import { getObservabilityBackend } from "./factory.js";

export type LogAttrs = Record<string, string | number | boolean>;

// Initialize file logger (degradation strategy: initialization failure does not affect business)
const obsFileLogger = new FileLogger({
  path: process.env.LOG_PATH || "/data/log/",
  filename: "observability.log",
  rotateSizeBytes: 100 * 1024 * 1024, // 100MB
  rotateBackupLimit: 10,
});

/**
 * Observability logging facade.
 * All methods are safe (do not throw exceptions, do not block business).
 */
export const obsLogger = {
  /**
   * INFO level log — used to record key nodes in normal flows.
   */
  info(eventName: string, attrs: LogAttrs = {}): void {
    try {
      getObservabilityBackend().log.info(eventName, attrs);
      // Simultaneously write to local log file
      obsFileLogger.write("INFO", eventName, attrs as Record<string, unknown>);
    } catch {
      // Fail silently, do not affect business
    }
  },

  /**
   * WARN level log — used to record recoverable exceptions (e.g., retry, degradation).
   */
  warn(eventName: string, attrs: LogAttrs = {}): void {
    try {
      getObservabilityBackend().log.warn(eventName, attrs);
      // Simultaneously write to local log file
      obsFileLogger.write("WARN", eventName, attrs as Record<string, unknown>);
    } catch {
      // Fail silently, do not affect business
    }
  },

  /**
   * ERROR level log — used to record unrecoverable errors (e.g., LLM timeout, VDB write failure).
   */
  error(eventName: string, attrs: LogAttrs = {}, error?: Error): void {
    try {
      if (error) {
        attrs = { ...attrs, "error.message": error.message, "error.type": error.name };
      }
      getObservabilityBackend().log.error(eventName, attrs, error);
      // Simultaneously write to local log file
      obsFileLogger.write("ERROR", eventName, attrs as Record<string, unknown>);
    } catch {
      // Fail silently, do not affect business
    }
  },
};
