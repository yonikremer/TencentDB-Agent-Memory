/**
 * health.test.ts — Route-level test for /health endpoint.
 */
import { describe, it, expect } from "vitest";
import { createHealthRoutes } from "./health.js";

describe("createHealthRoutes", () => {
  it("GET /health returns 200 ok + timestamp", async () => {
    const app = createHealthRoutes();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(new Date(body.timestamp).getTime()).not.toBeNaN();
  });

  it("unknown route yields 404", async () => {
    const app = createHealthRoutes();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
