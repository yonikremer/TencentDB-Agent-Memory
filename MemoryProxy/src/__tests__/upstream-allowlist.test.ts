import { describe, expect, it } from "vitest";
import { assertTrustedUpstreamUrl } from "../anthropicHandler.js";

// Regression tests: SSRF allowlist must reject non-allowlisted forward targets.
// (Identity review: proxy forwards caller-controlled bodies; target URLs must
// stay on configured upstreams.)
const cfg = (hosts: string[]) =>
  ({
    upstream: { url: `https://${hosts[0]}`, agents: {} },
  }) as never;

describe("assertTrustedUpstreamUrl", () => {
  it("rejects non-http(s) protocols", () => {
    expect(() =>
      assertTrustedUpstreamUrl(new URL("file:///etc/passwd"), cfg(["x"])),
    ).toThrow(/non-http/);
  });
  it("passes allowlisted host", () => {
    expect(() =>
      assertTrustedUpstreamUrl(
        new URL("https://api.anthropic.com/v1"),
        cfg(["api.anthropic.com"]),
      ),
    ).not.toThrow();
  });
  it("rejects non-allowlisted host", () => {
    expect(() =>
      assertTrustedUpstreamUrl(
        new URL("https://evil.example/"),
        cfg(["api.anthropic.com"]),
      ),
    ).toThrow(/non-allowlisted/);
  });
  it("matches hosts case-insensitively", () => {
    expect(() =>
      assertTrustedUpstreamUrl(
        new URL("https://API.ANTHROPIC.COM/v1"),
        cfg(["api.anthropic.com"]),
      ),
    ).not.toThrow();
  });
  it("protocol-only check without config", () => {
    expect(() =>
      assertTrustedUpstreamUrl(new URL("https://any.example/"), undefined),
    ).not.toThrow();
  });
});
