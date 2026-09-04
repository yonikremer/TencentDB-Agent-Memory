/**
 * SourceFetcher Interface Layer — Protocol-agnostic abstraction for source code fetching and security validation.
 *
 * Responsibility: Abstracting "fetching code from a source (git/local/ftp) into a local directory" into a unified interface,
 * with security validation (protocol whitelisting + SSRF protection) centralized in each implementation's validate() method.
 * Specific implementations (e.g. GitSourceFetcher) depend on simple-git, but this dependency does not leak into this interface layer.
 */

export type SourceType = "git" | "local" | "ftp";

export interface FetchResult {
  /** Local directory where source code is persisted (absolute path). */
  localPath: string;
  /** Current version identifier (first 12 chars of commit hash for git; null if unavailable). */
  version: string | null;
  /** Source protocol type. */
  sourceType: SourceType;
}

/**
 * Source fetcher interface. Implementations are responsible for:
 *   1. Validating sourceUrl security (protocol whitelist, SSRF, etc.)
 *   2. Fetching/syncing source code to localPath
 *   3. Returning version identifier
 *
 * Implementations:
 *   - GitSourceFetcher: simple-git, first version supports public HTTPS only (SSH/private repo auth see doc 005)
 *   - LocalSourceFetcher / FtpSourceFetcher: future extensions
 */
export interface ISourceFetcher {
  /** Initial fetch: download source code to localPath. */
  fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult>;

  /** Incremental sync: update existing localPath to latest version. */
  sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult>;

  /** Validate whether sourceUrl is valid (protocol whitelist + SSRF protection). Throws if invalid. */
  validate(sourceUrl: string): void;

  /** Supported protocol type. */
  readonly supportedType: SourceType;
}
