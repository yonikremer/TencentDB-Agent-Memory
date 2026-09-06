/**
 * platform-paths — cross-platform filesystem path helpers.
 *
 * Linux-first code assumed POSIX separators, $HOME, and /tmp fallbacks.
 * These helpers behave identically on POSIX and Windows by delegating to
 * node:os / node:path (which already switch on process.platform).
 *
 * NOTE: object-storage keys (COS / StorageAdapter / wiki POSIX paths) are
 * NOT filesystem paths — they always use forward slashes. Use
 * normalizeStorageKey() for those; use path.join/resolve/isPathInside()
 * for real filesystem paths.
 */
import os from "node:os";
import path from "node:path";

/** Home dir with env + tmpdir fallbacks (never returns empty). */
export function resolveHomeDir(): string {
  try {
    const h = os.homedir();
    if (h && h.trim().length > 0) return h;
  } catch { /* ignore — fall through to env */ }
  const fromEnv = process.env.HOME || process.env.USERPROFILE;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return os.tmpdir();
}

/**
 * Expand a leading ~ (~/, ~\\, or bare ~) to the home directory.
 * Returns the input unchanged when there is no tilde prefix.
 */
export function expandLeadingTilde(p: string, home: string = resolveHomeDir()): string {
  if (!p) return p;
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/** True for Windows drive-absolute (C:\\ / C:/) or UNC (\\\\server) paths. */
export function isWindowsAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/**
 * True when child resolves inside parent (or equals it).
 * Case-insensitive on win32 (FS is case-preserving but insensitive).
 * Use for traversal guards instead of fullPath.startsWith(base).
 */
export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (!rel) return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(".." + path.sep)) return false;
  return true;
}

/** True when a relative FS key escapes its root (.., absolute, drive, NUL). */
export function isEscapingRelativeKey(key: string): boolean {
  if (!key || key.includes("\0")) return true;
  if (path.isAbsolute(key) || isWindowsAbsolutePath(key)) return true;
  if (key.startsWith("/") || key.startsWith("\\")) return true;
  const parts = key.split(/[\\/]+/);
  return parts.includes("..");
}

/**
 * Normalize an OBJECT-STORAGE key (always POSIX "/"):
 * backslashes -> "/", collapse runs, strip leading slashes.
 */
export function normalizeStorageKey(key: string): string {
  return key.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "");
}

/** Case-aware containment check for resolved absolute paths. */
export function isResolvedInside(absRoot: string, absResolved: string): boolean {
  if (absResolved === absRoot) return true;
  if (process.platform === "win32") {
    return absResolved.toLowerCase().startsWith(absRoot.toLowerCase() + path.sep);
  }
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  return absResolved.startsWith(rootWithSep);
}
