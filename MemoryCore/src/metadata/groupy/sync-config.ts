/**
 * Org-hierarchy-sync — GROUPY_* env parsing (pure, testable). DESIGN.md §4.3.
 *
 * Reads from an injected env record (defaults to process.env) so unit tests
 * never touch the real environment.
 */

export interface GroupyConfig {
  enabled: boolean;
  baseUrl: string;
  token: string;
  roots: string[];
  cron: string;
  mockFile: string;
}

export const DEFAULT_GROUPY_CRON = "0 2 * * *";

export function parseGroupyConfig(env: Record<string, string | undefined>): GroupyConfig {
  const roots = (env.GROUPY_ROOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    enabled: env.GROUPY_ENABLED === "true",
    baseUrl: env.GROUPY_BASE_URL ?? "",
    token: env.GROUPY_TOKEN ?? "",
    roots,
    cron: env.GROUPY_CRON ?? DEFAULT_GROUPY_CRON,
    mockFile: env.GROUPY_MOCK_FILE ?? "",
  };
}

/** Production entry point: parse from the real process environment. */
export function loadGroupyConfig(): GroupyConfig {
  return parseGroupyConfig(process.env as Record<string, string | undefined>);
}
