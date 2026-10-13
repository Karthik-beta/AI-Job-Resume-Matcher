/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { serialQueue } from "./serial";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("serialQueue", () => {
  test("runs tasks one after another, in order", async () => {
    const enqueue = serialQueue();
    const events: string[] = [];
    const task = (name: string, delay: number) => async () => {
      events.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      events.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([enqueue(task("a", 10)), enqueue(task("b", 1))]);
    expect(results).toEqual(["a", "b"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b"]);
  });

  test("keeps going after a task fails, and reports the failure to its caller", async () => {
    const enqueue = serialQueue();
    const failed = enqueue(async () => {
      await tick();
      throw new Error("boom");
    });
    const next = enqueue(async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("ok");
  });

  test("does not start a task before the previous one settles", async () => {
    const enqueue = serialQueue();
    let release: () => void = () => {};
    const first = enqueue(() => new Promise<void>((resolve) => (release = resolve)));
    let started = false;
    const second = enqueue(async () => {
      started = true;
    });
    await tick();
    expect(started).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(started).toBe(true);
  });
});
