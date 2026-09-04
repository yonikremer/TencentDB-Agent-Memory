/**
 * file-logger.ts — Local log file writer
 *
 * Dual-writes logs to local files, supporting:
 * - File rotation (rotate)
 * - Backup file count limits
 * - Directory auto-creation
 * - Silent error handling (non-disruptive to main business process)
 *
 * Uses synchronous file writing (appendFileSync) to prevent WriteStream from blocking process exit.
 * Log volume is low and infrequent, so sync overhead is negligible.
 */

import fs from "node:fs";
import path from "node:path";

export interface FileLoggerConfig {
  /** Log file directory, e.g. /data/log/. File writing disabled when empty. */
  path: string;
  /** Log filename, e.g. core.log */
  filename: string;
  /** Max bytes per file, rotates when exceeded */
  rotateSizeBytes: number;
  /** Number of backup files to retain */
  rotateBackupLimit: number;
}

/**
 * FileLogger local log file writer.
 * Dual-writes logs to local file, supports rotation.
 */
export class FileLogger {
  private cfg: FileLoggerConfig;
  private currentSize = 0;
  private disabled = false;
  private filePath = "";

  constructor(cfg: FileLoggerConfig) {
    this.cfg = cfg;

    // Disable when path is empty
    if (!cfg.path) {
      this.disabled = true;
      return;
    }

    // Set default values
    if (this.cfg.rotateSizeBytes <= 0) {
      this.cfg.rotateSizeBytes = 100 * 1024 * 1024; // 100MB
    }
    if (this.cfg.rotateBackupLimit <= 0) {
      this.cfg.rotateBackupLimit = 10;
    }

    // Attempt initialization
    try {
      this.initFile();
    } catch (err) {
      this.disabled = true;
      process.stderr.write(`[file-logger] failed to init log file: ${err}\n`);
    }
  }

  /**
   * write a log entry.
   * Format: [timestamp][level] message {json data}\n
   */
  write(level: string, message: string, data?: Record<string, unknown>): void {
    if (this.disabled) {
      return;
    }

    try {
      const line = this.formatLine(level, message, data);
      this.writeLine(line);
    } catch {
      // Silent error handling on write failure, does not affect main workflow
    }
  }

  /**
   * flush buffer to disk (no-op in sync write mode, kept for interface compatibility).
   */
  async flush(): Promise<void> {
    // In sync write mode, data is already written to disk, no extra operation needed
  }

  /**
   * close (no-op in sync write mode, kept for interface compatibility).
   */
  close(): void {
    // In sync write mode, no close operation needed
  }

  // ─── Private methods ───

  private formatLine(level: string, message: string, data?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    let line = `[${timestamp}][${level}] ${message}`;

    if (data && Object.keys(data).length > 0) {
      // Sort keys to ensure stable output
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(data).sort()) {
        sorted[key] = data[key];
      }
      line += ` ${JSON.stringify(sorted)}`;
    }

    line += "\n";
    return line;
  }

  private writeLine(line: string): void {
    const lineBytes = Buffer.byteLength(line, "utf-8");

    // Check if rotation is needed
    if (this.currentSize + lineBytes > this.cfg.rotateSizeBytes) {
      this.rotate();
    }

    // Synchronous append write
    fs.appendFileSync(this.filePath, line, "utf-8");
    this.currentSize += lineBytes;
  }

  private initFile(): void {
    // Auto-create directory
    fs.mkdirSync(this.cfg.path, { recursive: true });

    this.filePath = path.join(this.cfg.path, this.cfg.filename);

    // Get current file size
    try {
      const stat = fs.statSync(this.filePath);
      this.currentSize = stat.size;
    } catch {
      this.currentSize = 0;
    }
  }

  private rotate(): void {
    try {
      this.currentSize = 0;

      // Rename current file to backup (with timestamp)
      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, "").replace("T", "_").replace("Z", "");
      const backupName = `${this.cfg.filename}.${ts}`;
      const backupPath = path.join(this.cfg.path, backupName);

      try {
        fs.renameSync(this.filePath, backupPath);
      } catch {
        // Failure to rename does not affect subsequent steps
      }

      // Clean up old backups exceeding limit
      this.cleanOldBackups();
    } catch (err) {
      this.disabled = true;
      process.stderr.write(`[file-logger] failed to rotate: ${err}\n`);
    }
  }

  private cleanOldBackups(): void {
    try {
      const entries = fs.readdirSync(this.cfg.path);
      const prefix = this.cfg.filename + ".";

      const backups = entries
        .filter((name) => name.startsWith(prefix) && name !== this.cfg.filename)
        .sort(); // Timestamp is in suffix, lexicographical order equals chronological order

      if (backups.length > this.cfg.rotateBackupLimit) {
        const toDelete = backups.slice(0, backups.length - this.cfg.rotateBackupLimit);
        for (const name of toDelete) {
          try {
            fs.unlinkSync(path.join(this.cfg.path, name));
          } catch {
            // Silent error handling on deletion failure
          }
        }
      }
    } catch {
      // Silent handling
    }
  }
}
