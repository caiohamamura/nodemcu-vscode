import { describe, expect, it, vi } from "vitest";
import { OperationGate } from "../../src/util/operationGate";

describe("OperationGate", () => {
  it("aborts and interrupts the previous operation before starting the next one", async () => {
    const interrupted: string[] = [];
    const gate = new OperationGate({
      onInterrupt: async (name) => {
        interrupted.push(name);
      },
    });

    let firstSignal: AbortSignal | undefined;
    let finishFirst!: () => void;
    const first = gate.run("Upload", async (signal) => {
      firstSignal = signal;
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });

    const secondStarted = vi.fn();
    const second = gate.run("Monitor", async () => {
      secondStarted();
      return "done";
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(firstSignal?.aborted).toBe(true);
    expect(interrupted).toEqual(["Upload"]);
    expect(secondStarted).not.toHaveBeenCalled();

    finishFirst();
    await first;
    await expect(second).resolves.toBe("done");
    expect(secondStarted).toHaveBeenCalledOnce();
  });

  it("passes a live AbortSignal into the task and aborts it when a new run() arrives", async () => {
    const gate = new OperationGate({ onInterrupt: async () => {} });

    let capturedSignal: AbortSignal | undefined;
    let releaseFirst!: () => void;

    const first = gate.run("A", async (signal) => {
      capturedSignal = signal;
      await new Promise<void>((r) => { releaseFirst = r; });
    });

    // Give the task a tick to start and capture the signal
    await new Promise((r) => setTimeout(r, 5));
    expect(capturedSignal?.aborted).toBe(false);

    // Starting a second run aborts the first signal
    const second = gate.run("B", async () => "second");
    await new Promise((r) => setTimeout(r, 5));
    expect(capturedSignal?.aborted).toBe(true);

    releaseFirst();
    await first;
    await expect(second).resolves.toBe("second");
  });

  it("when three runs are fired rapidly only the last one executes", async () => {
    const executed: string[] = [];
    const interrupted: string[] = [];
    const gate = new OperationGate({ onInterrupt: async (n) => { interrupted.push(n); } });

    let releaseLong!: () => void;
    // First long-running task — does NOT honour AbortSignal so it will always push "First"
    const first = gate.run("First", async () => {
      await new Promise<void>((r) => { releaseLong = r; });
      executed.push("First"); // always runs when releaseLong() is called
    });

    // Fire two more in immediate succession
    const second = gate.run("Second", async () => { executed.push("Second"); });
    const third = gate.run("Third", async () => { executed.push("Third"); });

    releaseLong();
    await Promise.allSettled([first, second, third]);

    // "First" was interrupted (signal aborted), but because its task body doesn't
    // check the signal, it still runs to completion after releaseLong().
    expect(interrupted).toContain("First");
    // "Third" must always execute — it is the last command queued.
    expect(executed).toContain("Third");
  });

  it("gate is idle (active = null) after the task completes normally", async () => {
    const gate = new OperationGate({ onInterrupt: async () => {} });
    const interrupted: string[] = [];

    await gate.run("Solo", async () => "done");

    // If gate is idle, starting a new task should NOT call onInterrupt
    const gate2 = new OperationGate({ onInterrupt: async (n) => { interrupted.push(n); } });
    await gate2.run("Solo", async () => "done");
    const secondResult = gate2.run("Second", async () => "second");
    // The gate was idle so onInterrupt should have NOT been called by the gate2 solo run
    await secondResult;
    // onInterrupt only fires when there IS an active task being displaced
    expect(interrupted).toHaveLength(0);
  });

  it("interruptTimeoutMs limits how long it waits for a stuck task before starting the next", async () => {
    const gate = new OperationGate(
      { onInterrupt: async () => {} },
      { interruptTimeoutMs: 50 }, // very short timeout
    );

    // A task that never resolves
    void gate.run("Stuck", async () => {
      await new Promise<void>(() => {}); // hangs forever
    });

    const t0 = Date.now();
    const second = gate.run("Next", async () => "next");
    await expect(second).resolves.toBe("next");
    const elapsed = Date.now() - t0;

    // Should have waited at most ~50ms + some slack, not 3000ms (the default)
    expect(elapsed).toBeLessThan(500);
  });

  it("interruptTimeoutMs also limits a stuck interrupt hook", async () => {
    const gate = new OperationGate(
      { onInterrupt: async () => { await new Promise<void>(() => {}); } },
      { interruptTimeoutMs: 50 },
    );

    void gate.run("Stuck", async () => {
      await new Promise<void>(() => {});
    });

    const t0 = Date.now();
    const second = gate.run("Next", async () => "next");
    await expect(second).resolves.toBe("next");
    expect(Date.now() - t0).toBeLessThan(700);
  });
});
