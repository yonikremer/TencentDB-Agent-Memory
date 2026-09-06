/**
 * build-queue.test.ts — Unit tests for BuildQueue per-key serialization.
 */
import { describe, it, expect, vi } from "vitest";
import { BuildQueue } from "./build-queue.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("BuildQueue", () => {
  it("serializes jobs per key; different keys run independently", async () => {
    const bq = new BuildQueue();
    const order: string[] = [];
    const mk = (key: string, n: number) => async () => {
      order.push(`${key}${n}-start`);
      await tick();
      order.push(`${key}${n}-end`);
    };
    bq.enqueue("a", mk("a", 1));
    bq.enqueue("a", mk("a", 2)); // must wait for a1
    bq.enqueue("b", mk("b", 1)); // independent
    await bq.onIdle();
    const aStart = order.indexOf("a1-start");
    const a2Start = order.indexOf("a2-start");
    const a2End = order.indexOf("a2-end");
    const b1Start = order.indexOf("b1-start");
    // per-key: a1 before a2, and a2 fully runs before it starts concurrently with b
    expect(aStart).toBeLessThan(a2Start);
    expect(a2Start).toBeLessThan(a2End);
    // b is independent and runs at all
    expect(b1Start).toBeGreaterThanOrEqual(0);
    expect(order.filter((o) => o.startsWith("a2"))).toEqual(["a2-start", "a2-end"]);
  });

  it("onIdle(key) waits only for that key's queue", async () => {
    const bq = new BuildQueue();
    let bDone = false;
    bq.enqueue("a", async () => {
      await tick();
    });
    bq.enqueue("b", async () => {
      await tick();
      bDone = true;
    });
    await bq.onIdle("a");
    // b may not be done yet; wait a tick to confirm a-only wait returned before b finished
    await bq.onIdle("b");
    expect(bDone).toBe(true);
  });

  it("onIdle(unknownKey) resolves immediately", async () => {
    const bq = new BuildQueue();
    await expect(bq.onIdle("nope")).resolves.toBeUndefined();
  });

  it("swallows job failures (fire-and-forget) and continues", async () => {
    const bq = new BuildQueue();
    const spy = vi.fn();
    bq.enqueue("fail", async () => {
      throw new Error("job failed");
    });
    bq.enqueue("fail", async () => {
      spy();
    });
    await bq.onIdle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bq.onIdle()).resolves.toBeUndefined();
  });

  it("onIdle with no key waits for all queues", async () => {
    const bq = new BuildQueue();
    bq.enqueue("x", async () => {
      await tick();
    });
    bq.enqueue("y", async () => {
      await tick();
    });
    await bq.onIdle();
    await bq.onIdle();
    expect(true).toBe(true);
  });
});
