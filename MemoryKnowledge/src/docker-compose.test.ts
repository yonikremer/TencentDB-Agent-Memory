/**
 * docker-compose.test.ts — boot-time config validation (no containers started).
 *
 * `docker compose config` resolves the compose file exactly like the boot
 * path does: YAML errors, bad interpolation, and missing hard-required vars
 * (e.g. PUBLIC_URL `:?`) fail here instead of at customer deploy time.
 * Skips cleanly where docker is unavailable.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMPOSE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "docker-compose.yml");

function haveDocker(): boolean {
  const r = spawnSync("docker", ["--version"], { encoding: "utf-8" });
  return r.status === 0;
}

const live = haveDocker() ? describe : describe.skip;

function composeConfig(env: Record<string, string>) {
  return spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "config"], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

live("docker compose config (boot path validation)", () => {
  it("resolves with documented env (PUBLIC_URL required)", () => {
    const r = composeConfig({ PUBLIC_URL: "http://203.0.113.10:8421/v3" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("knowledge:");
  });

  it("fails loudly without PUBLIC_URL (fail fast, not half-boot)", () => {
    const env = { ...process.env };
    delete env.PUBLIC_URL;
    const r = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "config"], { encoding: "utf-8", env });
    expect(r.status).not.toBe(0);
  });

  it("knowledge service keeps stable port + data volume", () => {
    const r = composeConfig({ PUBLIC_URL: "http://203.0.113.10:8421/v3" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/8421/);
    expect(r.stdout).toContain("knowledge-data");
  });
});
