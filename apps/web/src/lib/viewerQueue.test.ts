import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMoveQueue } from "./viewerQueue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createMoveQueue", () => {
  it("runs one move at a time in request order", async () => {
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const queue = createMoveQueue(async (id: string) => {
      calls.push(id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return `image-${id}`;
    });
    const first = queue.request("a");
    const second = queue.request("b");
    const [outcomeA, outcomeB] = await Promise.all([first.done, second.done]);
    // "a" started before "b" arrived, so both ran serially.
    assert.deepEqual(calls, ["a", "b"]);
    assert.equal(maxInFlight, 1);
    assert.equal(outcomeA.applied, false); // superseded by the newer request
    assert.equal(outcomeB.applied, true);
    assert.equal(outcomeB.result, "image-b");
  });

  it("coalesces rapid A→B→C selections so the viewer settles on C", async () => {
    const calls: string[] = [];
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    let callIndex = 0;
    const queue = createMoveQueue((id: string) => {
      calls.push(id);
      return gates[callIndex++].promise;
    });
    const ticketA = queue.request("a");
    const ticketB = queue.request("b");
    const ticketC = queue.request("c");
    await Promise.resolve();
    await Promise.resolve();
    // Only A is running; B and C are queued behind it.
    assert.deepEqual(calls, ["a"]);
    gates[0].resolve("image-a");
    const outcomeA = await ticketA.done;
    assert.equal(outcomeA.applied, false);
    await Promise.resolve();
    await Promise.resolve();
    // B was coalesced away; C runs next and is the latest.
    assert.deepEqual(calls, ["a", "c"]);
    gates[1].resolve("image-c");
    const [outcomeB, outcomeC] = await Promise.all([ticketB.done, ticketC.done]);
    assert.equal(outcomeB.applied, false);
    assert.equal(outcomeC.applied, true);
    assert.equal(outcomeC.result, "image-c");
  });

  it("delivers errors only to the latest request", async () => {
    const queue = createMoveQueue(async (id: string) => {
      if (id === "bad") throw new Error("move failed");
      return `image-${id}`;
    });
    const bad = await queue.request("bad").done;
    assert.equal(bad.applied, true);
    assert.ok(bad.error instanceof Error);
    const good = await queue.request("good").done;
    assert.equal(good.applied, true);
    assert.equal(good.result, "image-good");
  });

  it("marks superseded failures as not applied", async () => {
    const firstGate = deferred<string>();
    const calls: string[] = [];
    const queue = createMoveQueue((id: string) => {
      calls.push(id);
      return id === "a" ? firstGate.promise : Promise.resolve(`image-${id}`);
    });
    const ticketA = queue.request("a");
    await Promise.resolve();
    const ticketB = queue.request("b");
    firstGate.reject(new Error("stale failure"));
    const [outcomeA, outcomeB] = await Promise.all([ticketA.done, ticketB.done]);
    assert.equal(outcomeA.applied, false);
    assert.ok(outcomeA.error instanceof Error);
    assert.equal(outcomeB.applied, true);
  });
});
