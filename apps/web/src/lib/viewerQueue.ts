/**
 * Serialized viewer-move queue with coalescing.
 *
 * MapillaryJS `moveTo` calls are async: rapid A→B selections without
 * serialization can settle out of order. This queue guarantees at most one
 * in-flight move, skips every queued request except the newest (coalescing),
 * and reports per-request outcomes so stale completions never corrupt the
 * displayed image, status, or camera marker.
 *
 * Framework-free and unit-tested with a fake move function.
 */

export interface MoveOutcome {
  /** False when a newer request superseded this one; the caller must ignore it. */
  applied: boolean;
  result?: unknown;
  error?: unknown;
}

export interface MoveTicket {
  token: number;
  done: Promise<MoveOutcome>;
}

export interface MoveQueue {
  request: (id: string) => MoveTicket;
  latestToken: () => number;
}

interface QueueEntry {
  id: string;
  token: number;
}

export function createMoveQueue(moveFn: (id: string) => Promise<unknown>): MoveQueue {
  let tokenCounter = 0;
  let latestToken = 0;
  const queue: QueueEntry[] = [];
  const waiters = new Map<number, (outcome: MoveOutcome) => void>();
  let processing = false;

  function settle(token: number, outcome: MoveOutcome): void {
    const waiter = waiters.get(token);
    waiters.delete(token);
    waiter?.(outcome);
  }

  async function process(): Promise<void> {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        // Coalesce: run only the newest queued request.
        const item = queue[queue.length - 1];
        const dropped = queue.splice(0, queue.length - 1);
        queue.shift();
        for (const entry of dropped) settle(entry.token, { applied: false });
        let outcome: MoveOutcome;
        try {
          const result = await moveFn(item.id);
          outcome = { applied: item.token === latestToken, result };
        } catch (error) {
          outcome = { applied: item.token === latestToken, error };
        }
        settle(item.token, outcome);
      }
    } finally {
      processing = false;
    }
  }

  function request(id: string): MoveTicket {
    tokenCounter += 1;
    latestToken = tokenCounter;
    const entry: QueueEntry = { id, token: tokenCounter };
    queue.push(entry);
    const done = new Promise<MoveOutcome>((resolve) => {
      waiters.set(entry.token, resolve);
    });
    void process();
    return { token: entry.token, done };
  }

  return { request, latestToken: () => latestToken };
}
