import { describe, expect, it } from "vitest";
import { CommandQueue } from "../../src/util/commandQueue";

describe("CommandQueue", () => {
  it("executes tasks in FIFO order", async () => {
    const queue = new CommandQueue();
    const order: string[] = [];

    const a = queue.enqueue("A", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("A");
      return "a";
    });
    const b = queue.enqueue("B", async () => {
      order.push("B");
      return "b";
    });
    const c = queue.enqueue("C", async () => {
      order.push("C");
      return "c";
    });

    const results = await Promise.all([a, b, c]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("executes tasks sequentially — next starts only after previous resolves", async () => {
    const queue = new CommandQueue();
    let firstRunning = false;
    let secondStartedWhileFirstRunning = false;

    let releaseFirst!: () => void;
    const first = queue.enqueue("First", async () => {
      firstRunning = true;
      await new Promise<void>((r) => {
        releaseFirst = r;
      });
      firstRunning = false;
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(firstRunning).toBe(true);

    void queue.enqueue("Second", async () => {
      secondStartedWhileFirstRunning = firstRunning;
    });

    await new Promise((r) => setTimeout(r, 5));
    releaseFirst();
    await first;

    expect(secondStartedWhileFirstRunning).toBe(false);
  });

  it("passes a live AbortSignal that is not aborted initially", async () => {
    const queue = new CommandQueue();
    let captured: AbortSignal | undefined;

    await queue.enqueue("Task", async (signal) => {
      captured = signal;
    });

    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(false);
  });

  it("cancelPending rejects queued tasks but lets running task complete", async () => {
    const queue = new CommandQueue();
    let release!: () => void;

    const first = queue.enqueue("First", async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return "first-done";
    });

    await new Promise((r) => setTimeout(r, 5));

    const second = queue.enqueue("Second", async () => "second-done");
    const third = queue.enqueue("Third", async () => "third-done");

    queue.cancelPending();

    await expect(second).rejects.toThrow("Queued command cancelled: Second");
    await expect(third).rejects.toThrow("Queued command cancelled: Third");

    release();
    await expect(first).resolves.toBe("first-done");
  });

  it("cancelRunning aborts the running task's signal", async () => {
    const queue = new CommandQueue();
    let capturedSignal: AbortSignal | undefined;

    const task = queue.enqueue("Task", async (signal) => {
      capturedSignal = signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(capturedSignal!.aborted).toBe(false);

    queue.cancelRunning();
    await expect(task).rejects.toThrow("aborted");
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("cancelAll cancels both running and pending", async () => {
    const queue = new CommandQueue();
    let release!: () => void;

    const first = queue.enqueue("First", async () => {
      await new Promise<void>((r) => {
        release = r;
      });
    });

    await new Promise((r) => setTimeout(r, 5));
    const second = queue.enqueue("Second", async () => "ok");

    queue.cancelAll();

    await expect(second).rejects.toThrow("Queued command cancelled: Second");

    release();
    await first;
  });

  it("error in one task does not block subsequent tasks", async () => {
    const queue = new CommandQueue();
    const results: string[] = [];

    const a = queue.enqueue("A", async () => {
      results.push("A");
      throw new Error("boom");
    });
    const b = queue.enqueue("B", async () => {
      results.push("B");
      return "b";
    });

    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe("b");
    expect(results).toEqual(["A", "B"]);
  });

  it("getState returns correct running and pending info", async () => {
    const queue = new CommandQueue();
    let release!: () => void;

    void queue.enqueue("First", async () => {
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await new Promise((r) => setTimeout(r, 5));
    void queue.enqueue("Second", async () => {});
    void queue.enqueue("Third", async () => {});

    const state = queue.getState();
    expect(state.running).not.toBeNull();
    expect(state.running!.name).toBe("First");
    expect(state.pending).toHaveLength(2);
    expect(state.pending[0]).toEqual({ name: "Second", position: 1 });
    expect(state.pending[1]).toEqual({ name: "Third", position: 2 });

    release();
    await new Promise((r) => setTimeout(r, 20));

    const idle = queue.getState();
    expect(idle.running).toBeNull();
    expect(idle.pending).toHaveLength(0);
  });

  it("emits 'change' event on state transitions", async () => {
    const queue = new CommandQueue();
    const changes: Array<{ runningName: string | null; pendingCount: number }> = [];

    queue.on("change", (state: { running: { name: string } | null; pending: unknown[] }) => {
      changes.push({
        runningName: state.running?.name ?? null,
        pendingCount: state.pending.length,
      });
    });

    let release!: () => void;
    const first = queue.enqueue("A", async () => {
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await new Promise((r) => setTimeout(r, 5));

    const second = queue.enqueue("B", async () => {});
    await new Promise((r) => setTimeout(r, 5));

    release();
    await Promise.all([first, second]);
    await new Promise((r) => setTimeout(r, 10));

    expect(changes.length).toBeGreaterThanOrEqual(5);
    // First enqueue: pending=1, then drain starts it: running=A, pending=0
    expect(changes[0]).toEqual({ runningName: null, pendingCount: 1 });
    expect(changes[1]).toEqual({ runningName: "A", pendingCount: 0 });
    // Second enqueue: running=A, pending=1
    expect(changes[2]).toEqual({ runningName: "A", pendingCount: 1 });
  });

  it("enqueue on idle queue starts immediately", async () => {
    const queue = new CommandQueue();
    let started = false;

    const p = queue.enqueue("Solo", async () => {
      started = true;
    });

    await p;
    expect(started).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(queue.getState().running).toBeNull();
  });

  it("cancelPending on empty queue is a no-op", () => {
    const queue = new CommandQueue();
    queue.cancelPending();
    expect(queue.getState().pending).toHaveLength(0);
  });

  it("cancelRunning when idle is a no-op", () => {
    const queue = new CommandQueue();
    queue.cancelRunning();
    expect(queue.getState().running).toBeNull();
  });

  it("pending tasks still run after cancelPending clears only queued ones", async () => {
    const queue = new CommandQueue();
    const executed: string[] = [];
    let release!: () => void;

    const first = queue.enqueue("First", async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      executed.push("First");
    });

    await new Promise((r) => setTimeout(r, 5));

    const second = queue.enqueue("Second", async () => {
      executed.push("Second");
    });
    const third = queue.enqueue("Third", async () => {
      executed.push("Third");
    });

    queue.cancelPending();
    await expect(second).rejects.toThrow();
    await expect(third).rejects.toThrow();

    release();
    await first;
    expect(executed).toEqual(["First"]);
  });
});
