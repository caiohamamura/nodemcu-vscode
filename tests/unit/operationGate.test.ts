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
});
