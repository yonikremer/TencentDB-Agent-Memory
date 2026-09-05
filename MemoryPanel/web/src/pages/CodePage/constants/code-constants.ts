/**
 * code-constants —— Constants, types, and pure utility functions for the Code asset page.
 * Extracted from CodeSourcesPanel.tsx.
 *
 * Common asset types and formatShortTime have been consolidated into @/lib/asset-common; this re-exports them here
 * Keep the original import path unchanged.
 */
export type { SubView, ViewMode, StatusFilter, ScopeTab } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

/**
 * Validate whether it is a valid HTTP(S) Git repository URL (regex matching).
 * Requirements: http/https protocol, host contains a dot (real domain), path has no spaces and ends with .git.
 * Use regex instead of URL parsing — new URL() accepts spaces in the path (e.g., /a b/repo.git)
 * and does not enforce the .git suffix, both of which do not meet the strict constraints for code graph registration.
 * SSH (git@...) is not judged as true here — the caller will separately indicate "SSH is not supported for now".
 */
const GIT_HTTP_URL_RE = /^https?:\/\/[^\s/]+\.[^\s/]+\/[^\s]+\.git$/i;
export function isValidGitHttpUrl(raw: string): boolean {
  return GIT_HTTP_URL_RE.test(raw.trim());
}

/**
 * Extract a readable repository name from a Git URL.
 *
 * `repo_name` may be empty (old data), in which case falling back to the URL can make it appear long.
 * Here, we extract the last two path segments from the URL as the `namespace/repo` format:
 *   https://gitlab.example.com/namespace/repo.git → namespace/repo
 *   https://github.com/org/project.git → org/project
 *   https://git.woa.com/group/sub/repo.git → sub/repo
 * If there is only one path segment, return that segment directly (removing the .git suffix).
 * Return the original URL as a fallback when parsing fails.
 */
export function formatRepoName(repoName: string, repoUrl: string): string {
  if (repoName && !repoName.startsWith('http')) return repoName;
  const url = repoName || repoUrl;
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    if (segments.length === 1) return segments[0];
  } catch {
    // fallback
  }
  return url;
}
