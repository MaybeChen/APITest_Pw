import { EventEmitter } from "node:events";
import type { BrowserContext } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import { observeUINetwork } from "../../packages/runner/src/ui-network";

afterEach(() => vi.useRealTimers());

it("waits for in-flight requests and restarts the full one-second quiet period", async () => {
  vi.useFakeTimers();
  const context = new EventEmitter();
  const observer = observeUINetwork(context as unknown as BrowserContext);
  const request = { url: () => "https://example.com/init" };
  context.emit("request", request);
  let done = false;
  const waiting = observer.wait().then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(1500);
  expect(done).toBe(false);
  context.emit("requestfinished", request);
  await vi.advanceTimersByTimeAsync(900);
  expect(done).toBe(false);
  context.emit("request", request);
  context.emit("requestfailed", request);
  await vi.advanceTimersByTimeAsync(999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(51);
  await waiting;
  expect(done).toBe(true);
  observer.close();
  expect(context.eventNames()).toEqual([]);
});

it("fails instead of starting API calls while a request remains active", async () => {
  vi.useFakeTimers();
  const context = new EventEmitter();
  const observer = observeUINetwork(context as unknown as BrowserContext);
  context.emit("request", { url: () => "https://example.com/stream" });
  const failure = expect(observer.wait(2000)).rejects.toThrow(
    "前置 UI 网络未稳定",
  );
  await vi.advanceTimersByTimeAsync(2000);
  await failure;
  observer.close();
  expect(context.eventNames()).toEqual([]);
});
