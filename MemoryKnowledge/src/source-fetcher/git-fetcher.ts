/**
 * GitSourceFetcher — Source code fetching implementation based on simple-git.
 *
 * simple-git uses child_process.spawn + args array internally without invoking shell, eliminating shell injection at the foundational level.
 *
 * Security protection (002 §4-5):
 *   - R1 git hooks: clone/fetch naturally does not pull remote .git/hooks (hooks are local state), so core.hooksPath is not additionally
 *     configured (hardened git rejects this config without allowUnsafeHooksPath).
 *   - R2 SSRF: Only public HTTPS + private/loopback address blacklist permitted (aligned with project security_rules).
 *   - Bug fix (Option A): Incremental sync git clean excludes .codegraph/ to avoid deleting the codegraph index repository.
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

/**
 * Private / loopback / link-local address blacklist (standard subnets):
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 private subnets
 *   - 169.254.                     → link-local (includes cloud metadata 169.254.169.254)
 *   - 127. / 0. / localhost / ::1  → loopback
 *   - fe80:                        → IPv6 link-local
 *
 * This blacklist can be disabled via environment variable KNOWLEDGE_SSRF_CHECK=off (see GitSourceFetcher constructor).
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/**
 * Reads SSRF private network blacklist toggle. Enabled by default;
 * disabled when KNOWLEDGE_SSRF_CHECK is off/false/0/no (case-insensitive).
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

export interface GitSourceFetcherOptions {
  /**
   * Whether to enable SSRF private / loopback address blacklist validation.
   * Reads environment variable KNOWLEDGE_SSRF_CHECK by default (enabled by default); takes precedence when explicitly passed.
   */
  ssrfCheck?: boolean;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** SSRF private blacklist validation toggle (https-only protocol check always active, unaffected by this toggle). */
  private readonly ssrfCheck: boolean;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
  }

  validate(sourceUrl: string): void {
    // First version: only supports public HTTPS repos (SSH / private repo auth see doc 005).
    if (!sourceUrl.startsWith("https://")) {
      throw new Error(
        "first version only supports public HTTPS repos; SSH/private repo support coming soon",
      );
    }
    const host = this.extractHost(sourceUrl);
    if (!host) {
      throw new Error(`invalid repo_url: cannot parse host from ${sourceUrl}`);
    }
    // R2: SSRF protection — Prohibit pointing to private/loopback addresses (can be disabled via KNOWLEDGE_SSRF_CHECK=off).
    if (this.ssrfCheck && this.isPrivateAddress(host)) {
      throw new Error(`repo_url must not point to private/loopback address: ${host}`);
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    // Shallow clone single branch. Note: git clone/fetch does not pull remote .git/hooks (hooks are local state),
    // so normal repo clones do not bring executable hooks; core.hooksPath is no longer configured here
    // (hardened git rejects this config: requires allowUnsafeHooksPath).
    await simpleGit().clone(sourceUrl, localPath, {
      "--depth": 1,
      "--branch": branch,
    });
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const git = simpleGit(localPath);
    await git.fetch("origin", branch, { "--depth": 1 });
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    // Bug fix (Option A): clean excludes .codegraph/, otherwise it deletes the codegraph index repository,
    // causing incremental sync to always fail and fall back to full clone every time.
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  // ── Internal helpers ──

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  private extractHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}
