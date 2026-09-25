import assert from "node:assert/strict";
import { it } from "node:test";
import { RunScheduler } from "./run-scheduler.js";

it("admits five, executes three, and starts waiting runs in FIFO order", async () => {
  const scheduler = new RunScheduler(3, 5);
  const started: number[] = [];
  const finish: Array<() => void> = [];
  for (let n = 1; n <= 5; n++) {
    assert.equal(scheduler.admit(String(n), () => new Promise<void>((resolve) => {
      started.push(n);
      finish[n] = resolve;
    })), true);
  }
  assert.equal(scheduler.admit("6", async () => {}), false);
  await Promise.resolve();
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(scheduler.activeCount, 3);
  assert.equal(scheduler.waitingPosition("4"), 1);
  assert.equal(scheduler.waitingPosition("5"), 2);
  finish[2]!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3, 4]);
  assert.equal(scheduler.waitingPosition("5"), 1);
  assert.equal(scheduler.removeWaiting("5"), true);
  assert.equal(scheduler.admit("6", async () => {}), true);
  finish[1]!();
  finish[3]!();
  finish[4]!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3, 4]);
});

it("releases a slot when an operation fails", async () => {
  const scheduler = new RunScheduler(1, 2);
  let secondStarted = false;
  scheduler.admit("first", async () => { throw new Error("worker failed"); });
  scheduler.admit("second", async () => { secondStarted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, true);
});
