/**
 * Log port (abstract). Business/infrastructure only relies on this interface and is not bound to a specific log library.
 * Replace the implementation (console / pino / report to the log platform) and only change the adapter + container.
 * 见 docs/architecture/06-logging.md。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured fields are output together with a log. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /**
   * Derive a child logger with fixed fields (such as reqId / userId),
   * 之后该 logger 打的每条日志都自动带上这些字段，便于串联一次请求。
   */
  child(bindings: LogFields): Logger;
}
