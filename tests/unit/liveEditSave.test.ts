/**
 * Integration tests for the CommandQueue + live-edit save wiring.
 *
 * These tests replicate the logic in extension.ts where onDidSaveTextDocument
 * enqueues upload tasks via commandQueue.enqueue().
 *
 * With the CommandQueue (FIFO, no interruption):
 *   1. Two rapid saves → both run sequentially; both uploads commit.
 *   2. The AbortSignal received by the upload task is NOT aborted by a new
 *      enqueue — only by explicit cancelRunning().
 *   3. Calling an unrelated command (e.g. "Upload File") while a live-edit
 *      save is in progress queues it; it runs after the current save finishes.
 *   4. cancelPending() rejects queued saves but lets the running one complete.
 */

import { describe, it, expect } from "vitest";
import { CommandQueue } from "../../src/util/commandQueue";

interface FakeDoc {
  content: string;
  remoteName: string;
  port: string;
}

describe("CommandQueue + live-edit save wiring", () => {
  it("two rapid saves: both run sequentially and both uploads commit", async () => {
    const calls: Array<{ content: string; remoteName: string }> = [];
    const queue = new CommandQueue();

    const docA: FakeDoc = { content: "v1", remoteName: "init.lua", port: "COM7" };
    const docB: FakeDoc = { content: "v2", remoteName: "init.lua", port: "COM7" };

    const saveA = queue.enqueue("Save Live Device File", async () => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push({ content: docA.content, remoteName: docA.remoteName });
    });

    const saveB = queue.enqueue("Save Live Device File", async () => {
      await new Promise((r) => setTimeout(r, 5));
      calls.push({ content: docB.content, remoteName: docB.remoteName });
    });

    await Promise.all([saveA, saveB]);

    expect(calls).toHaveLength(2);
    expect(calls[0].content).toBe("v1");
    expect(calls[1].content).toBe("v2");
  });

  it("the AbortSignal is NOT aborted when a new command is enqueued", async () => {
    const queue = new CommandQueue();
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;

    let releaseFirst!: () => void;
    const first = queue.enqueue("Save Live Device File", async (signal) => {
      firstSignal = signal;
      await new Promise<void>((r) => { releaseFirst = r; });
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(firstSignal!.aborted).toBe(false);

    const second = queue.enqueue("Upload File", async (signal) => {
      secondSignal = signal;
    });

    await new Promise((r) => setTimeout(r, 5));
    // The first task's signal should NOT be aborted just because a new task was enqueued
    expect(firstSignal!.aborted).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondSignal).toBeDefined();
  });

  it("an 'Upload File' command waits in queue and runs after the live-edit save finishes", async () => {
    const queue = new CommandQueue();
    const executedCommands: string[] = [];

    let releaseSave!: () => void;
    const save = queue.enqueue("Save Live Device File", async () => {
      await new Promise<void>((r) => { releaseSave = r; });
      executedCommands.push("Save Live Device File");
    });

    await new Promise((r) => setTimeout(r, 5));

    const uploadChanges = queue.enqueue("Upload Changes", async () => {
      executedCommands.push("Upload Changes");
      return "ok";
    });

    // Upload Changes should be queued, not running yet
    expect(queue.getState().pending).toHaveLength(1);
    expect(queue.getState().pending[0].name).toBe("Upload Changes");

    releaseSave();
    await Promise.all([save, uploadChanges]);

    expect(executedCommands).toEqual(["Save Live Device File", "Upload Changes"]);
    expect(await uploadChanges).toBe("ok");
  });

  it("a finished save does not affect the next unrelated save", async () => {
    const queue = new CommandQueue();
    const executed: string[] = [];

    await queue.enqueue("Save Live Device File", async () => {
      executed.push("A");
    });

    await queue.enqueue("Save Live Device File", async () => {
      executed.push("B");
    });

    expect(executed).toEqual(["A", "B"]);
    await new Promise((r) => setTimeout(r, 5));
    expect(queue.getState().running).toBeNull();
  });

  it("three rapid saves: all three run and commit in order", async () => {
    const uploadCalls: string[] = [];
    const queue = new CommandQueue();

    const makeUpload = (content: string, stallMs: number) =>
      queue.enqueue("Save Live Device File", async () => {
        await new Promise((r) => setTimeout(r, stallMs));
        uploadCalls.push(content);
      });

    const a = makeUpload("v1", 20);
    const b = makeUpload("v2", 10);
    const c = makeUpload("v3", 5);

    await Promise.all([a, b, c]);

    expect(uploadCalls).toEqual(["v1", "v2", "v3"]);
  });

  it("cancelPending rejects queued saves but lets the running one complete", async () => {
    const queue = new CommandQueue();
    const committed: string[] = [];

    let release!: () => void;
    const first = queue.enqueue("Save Live Device File", async () => {
      await new Promise<void>((r) => { release = r; });
      committed.push("first");
    });

    await new Promise((r) => setTimeout(r, 5));

    const second = queue.enqueue("Save Live Device File", async () => {
      committed.push("second");
    });
    const third = queue.enqueue("Save Live Device File", async () => {
      committed.push("third");
    });

    queue.cancelPending();

    await expect(second).rejects.toThrow("Queued command cancelled");
    await expect(third).rejects.toThrow("Queued command cancelled");

    release();
    await first;
    expect(committed).toEqual(["first"]);
  });

  it("cancelRunning aborts the running save's signal", async () => {
    const queue = new CommandQueue();
    let capturedSignal: AbortSignal | undefined;

    const save = queue.enqueue("Save Live Device File", async (signal) => {
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
    await expect(save).rejects.toThrow("aborted");
    expect(capturedSignal!.aborted).toBe(true);
  });
});
