import { describe, it, expect } from "vitest";
import { MemoryGenerationLogClient } from "../src/v3/memory-generation-log-client.js";
import { ParamError } from "../src/errors.js";
import type { Transport } from "../src/client.js";

class FakeTransport implements Transport {
  calls: Array<{ path: string; body: Record<string, unknown>; method: string }> = [];
  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, body, method: "POST" });
    return {} as T;
  }
  async get<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, body, method: "GET" });
    return {} as T;
  }
}

class FakeTransportNoGet implements Transport {
  calls: Array<{ path: string; body: Record<string, unknown>; method: string }> = [];
  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, body, method: "POST" });
    return {} as T;
  }
}

const CONFIG = { endpoint: "http://mem.example.com", apiKey: "k", serviceId: "s" };

describe("MemoryGenerationLogClient", () => {
  it("constructs from config and transport", () => {
    expect(new MemoryGenerationLogClient(CONFIG)).toBeInstanceOf(MemoryGenerationLogClient);
    const fake = new FakeTransport();
    expect(new MemoryGenerationLogClient(fake)).toBeInstanceOf(MemoryGenerationLogClient);
  });

  it("list uses GET with stripped params", async () => {
    const fake = new FakeTransport();
    const c = new MemoryGenerationLogClient(fake);
    await c.list();
    expect(fake.calls[0]).toEqual({ path: "/v3/memory-generation-log/list", body: {}, method: "GET" });
    await c.list({ memory_id: "m1", layer: "l1", limit: 5, offset: 1 });
    expect(fake.calls[1]!.body).toEqual({ memory_id: "m1", layer: "l1", limit: 5, offset: 1 });
  });

  it("get by log_id via GET", async () => {
    const fake = new FakeTransport();
    const c = new MemoryGenerationLogClient(fake);
    await c.get({ log_id: "lg-1" });
    expect(fake.calls[0]!.path).toBe("/v3/memory-generation-log/get");
    expect(fake.calls[0]!.method).toBe("GET");
    expect(fake.calls[0]!.body).toEqual({ log_id: "lg-1" });
  });

  it("get by memory_id and validates both forms", async () => {
    const fake = new FakeTransport();
    const c = new MemoryGenerationLogClient(fake);
    expect(() => c.get({ log_id: "" })).toThrow(ParamError);
    expect(() => c.get({ memory_id: " " })).toThrow(ParamError);
    await c.get({ memory_id: "m-2", layer: "l2" });
    expect(fake.calls[0]!.body).toEqual({ memory_id: "m-2", layer: "l2" });
    await c.getByMemoryId("m-3", "l3");
    expect(fake.calls[1]!.body).toEqual({ memory_id: "m-3", layer: "l3" });
  });

  it("falls back to POST when transport lacks get", async () => {
    const fake = new FakeTransportNoGet();
    const c = new MemoryGenerationLogClient(fake);
    await c.list({ layer: "l1" });
    expect(fake.calls[0]!.method).toBe("POST");
    expect(fake.calls[0]!.body).toEqual({ layer: "l1" });
  });
});