/**
 * serial-queue.test.ts — Unit tests for SerialQueue (concurrency=1 FIFO queue).
 */
import { describe, it, expect, vi } from "vitest";
import { SerialQueue } from "./serial-queue.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("SerialQueue", () => {
  it("executes tasks FIFO with concurrency 1", async () => {
    const q = new SerialQueue("fifo");
    const order: number[] = [];
    const mk = (n: number) => async () => {
      order.push(n);
      await tick();
      order.push(-n);
      return n;
    };
    const results = await Promise.all([q.add(mk(1)), q.add(mk(2)), q.add(mk(3))]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, -1, 2, -2, 3, -3]);
    await q.onIdle();
    expect(q.idle).toBe(true);
  });

  it("propagates task rejection and continues with next task", async () => {
    const q = new SerialQueue();
    await expect(q.add(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const v = await q.add(async () => 42);
    expect(v).toBe(42);
    await q.onIdle();
    expect(q.idle).toBe(true);
  });

  it("pause() holds execution; start() resumes and drains", async () => {
    const q = new SerialQueue();
    q.pause();
    const ran: string[] = [];
    const p = q.add(async () => {
      ran.push("a");
      return 1;
    });
    await tick();
    expect(ran).toEqual([]);
    expect(q.size).toBe(1);
    q.start();
    await p;
    await q.onIdle();
    expect(ran).toEqual(["a"]);
    expect(q.pending).toBe(false);
  });

  it("pause() while running finishes current task then holds the next", async () => {
    const q = new SerialQueue();
    const ran: string[] = [];
    const first = q.add(async () => {
      ran.push("first");
      await tick();
    });
    // queue second, then pause before drain of second begins
    const second = q.add(async () => {
      ran.push("second");
    });
    await first;
    q.pause();
    await tick();
    expect(ran).toEqual(["first"]);
    q.start();
    await second;
    expect(ran).toEqual(["first", "second"]);
  });

  it("onIdle resolves immediately when idle", async () => {
    const q = new SerialQueue();
    await q.onIdle();
    expect(q.idle).toBe(true);
  });

  it("onIdle waits for queued + running tasks and multiple callers", async () => {
    const q = new SerialQueue();
    let done = false;
    const task = q.add(async () => {
      await tick();
      done = true;
    });
    const a = q.onIdle();
    const b = q.onIdle();
    await Promise.all([a, b, task]);
    expect(done).toBe(true);
    await q.onIdle();
  });

  it("clear() rejects queued tasks with Queue cleared and leaves queue empty", async () => {
    const q = new SerialQueue();
    q.pause();
    const p1 = q.add(async () => 1).catch((e: Error) => e.message);
    const p2 = q.add(async () => 2).catch((e: Error) => e.message);
    q.clear();
    expect(await p1).toBe("Queue cleared");
    expect(await p2).toBe("Queue cleared");
    expect(q.size).toBe(0);
    expect(q.idle).toBe(true);
    q.start();
    expect(q.pending).toBe(false);
  });

  it("size/pending reflect live state", async () => {
    const q = new SerialQueue();
    q.pause();
    const p1 = q.add(async () => 1);
    q.add(async () => 2);
    expect(q.size).toBe(2);
    expect(q.pending).toBe(false);
    q.start();
    await p1;
    expect(q.pending).toBe(true);
    await q.onIdle();
    expect(q.size).toBe(0);
    expect(q.pending).toBe(false);
  });

  it("respects a custom name", () => {
    const q = new SerialQueue("custom-name");
    expect(q.name).toBe("custom-name");
    const anon = new SerialQueue();
    expect(anon.name).toBe("unnamed");
  });

  it("handles synchronous throw inside task", async () => {
    const q = new SerialQueue();
    await expect(q.add(() => Promise.reject(new Error("sync-throw")))).rejects.toThrow("sync-throw");
  });
});
