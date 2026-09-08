/**
 * /v3/instance/destroy contract (API consolidation; legacy /v2 route deleted):
 * - missing instance_id → 400, nothing purged
 * - valid call with absent backends → 200, code 0, instance echoed
 *
 * Exercises TdaiGateway.handleInstanceDestroy without booting the full
 * stack (all backends optional; metadata pool mocked).
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { TdaiGateway } from "./server.js";

function fakeReq(body: unknown): http.IncomingMessage {
  const em = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    resume: () => void;
    destroy: () => void;
  };
  em.headers = {};
  em.resume = () => {};
  em.destroy = () => {};
  process.nextTick(() => {
    em.emit("data", Buffer.from(JSON.stringify(body)));
    em.emit("end");
  });
  return em as unknown as http.IncomingMessage;
}

function fakeRes(): {
  res: http.ServerResponse;
  seen: { status: number; body: unknown }[];
} {
  const seen: { status: number; body: unknown }[] = [];
  const res = {
    writeHead(_status: number) {},
    end(data: string) {
      seen.push({
        status: (this as { statusCode?: number }).statusCode ?? 0,
        body: JSON.parse(data),
      });
    },
  } as unknown as http.ServerResponse;
  return { res, seen };
}

function dispatchReq(pathname: string, body: unknown): http.IncomingMessage {
  const em = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    resume: () => void;
    destroy: () => void;
  };
  em.headers = { host: "localhost" };
  em.resume = () => {};
  em.destroy = () => {};
  (em as unknown as { url?: string; method?: string }).url = pathname;
  (em as unknown as { url?: string; method?: string }).method = "POST";
  process.nextTick(() => {
    em.emit("data", Buffer.from(JSON.stringify(body)));
    em.emit("end");
  });
  return em as unknown as http.IncomingMessage;
}

function dispatchRes(): { res: http.ServerResponse; statuses: number[]; bodies: unknown[] } {
  const statuses: number[] = [];
  const bodies: unknown[] = [];
  const res = {
    writeHead(status: number) {
      statuses.push(status);
    },
    end(data: string) {
      bodies.push(JSON.parse(data));
    },
    setHeader() {},
  } as unknown as http.ServerResponse;
  return { res, statuses, bodies };
}

function bareGateway(): TdaiGateway {
  const noop = () => {};
  const gw = Object.create(TdaiGateway.prototype) as Record<string, unknown>;
  gw.logger = { info: noop, error: noop, warn: noop, debug: noop };
  gw.config = { server: { corsOrigins: [] }, deployMode: "standalone", offload: {} };
  gw.conversationAddByInstance = new Map<string, unknown>();
  gw.metadataServiceByInstance = new Map<string, unknown>();
  gw.ensureMetadataStorePool = async () => ({
    purgeInstance: async (_id: string) => ({ db_name: "test", dropped: true }),
  });
  return gw as unknown as TdaiGateway;
}

describe("/v3/instance/destroy", () => {
  it("rejects missing instance_id with 400", async () => {
    const gw = bareGateway();
    const { res, seen } = fakeRes();
    await (
      gw as unknown as {
        handleInstanceDestroy(r: unknown, s: unknown): Promise<void>;
      }
    ).handleInstanceDestroy(fakeReq({}), res);
    // sendJson writes status via writeHead; capture from the envelope instead
    expect((seen[0]?.body as { code?: number }).code).toBe(400);
  });

  it("purges with absent backends and echoes the instance", async () => {
    const gw = bareGateway();
    const statuses: number[] = [];
    const bodies: unknown[] = [];
    const res = {
      writeHead(status: number) {
        statuses.push(status);
      },
      end(data: string) {
        bodies.push(JSON.parse(data));
      },
    } as unknown as http.ServerResponse;
    await (
      gw as unknown as {
        handleInstanceDestroy(r: unknown, s: unknown): Promise<void>;
      }
    ).handleInstanceDestroy(fakeReq({ instance_id: "i1" }), res);
    expect(statuses[0]).toBe(200);
    const body = bodies[0] as {
      code?: number;
      data?: { instance_id?: string; cleaned?: Record<string, unknown> };
    };
    expect(body.code).toBe(0);
    expect(body.data?.instance_id).toBe("i1");
    expect(
      (body.data?.cleaned?.skill_queue as { backend?: string })?.backend,
    ).toBe("none");
    expect(
      (body.data?.cleaned?.v3_metadata as { dropped?: boolean })?.dropped,
    ).toBe(true);
  });
});

describe("dispatch wiring (v3-only)", () => {
  async function dispatch(pathname: string, body: unknown) {
    const gw = bareGateway();
    const { res, statuses, bodies } = dispatchRes();
    await (
      gw as unknown as { handleRequest(r: unknown, s: unknown): Promise<void> }
    ).handleRequest(dispatchReq(pathname, body), res);
    return { statuses, bodies };
  }

  it("legacy /v2/instance/destroy falls through to 404", async () => {
    const { statuses } = await dispatch("/v2/instance/destroy", { instance_id: "i1" });
    expect(statuses[0]).toBe(404);
  });

  it("routes /v3/instance/destroy (400 without instance_id)", async () => {
    const { statuses, bodies } = await dispatch("/v3/instance/destroy", {});
    expect(statuses[0]).toBe(400);
    expect((bodies[0] as { code?: number }).code).toBe(400);
  });

  it("routes /v3/instance/destroy (200 with instance_id)", async () => {
    const { statuses, bodies } = await dispatch("/v3/instance/destroy", { instance_id: "i9" });
    expect(statuses[0]).toBe(200);
    const body = bodies[0] as { code?: number; data?: { instance_id?: string } };
    expect(body.code).toBe(0);
    expect(body.data?.instance_id).toBe("i9");
  });
});
