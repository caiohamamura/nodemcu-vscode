/**
 * Integration tests for the OperationGate + live-edit save wiring.
 *
 * These tests replicate the logic in extension.ts lines 1640-1643:
 *
 *   vscode.workspace.onDidSaveTextDocument((doc) => {
 *     if (doc.uri.scheme === LIVE_EDIT_SCHEME) {
 *       void operationGate.run("Save Live Device File", (signal) =>
 *         uploadLiveDocument(doc, signal));
 *     }
 *   });
 *
 * Without launching a real VS Code host we exercise:
 *   1. Two rapid saves → second aborts the first; upload is called with the
 *      content of the *second* document.
 *   2. The AbortSignal received by the upload function is the one owned by
 *      the gate (i.e. it is aborted when the third command preempts).
 *   3. Calling an unrelated command (e.g. "Upload File") while a live-edit
 *      save is in progress interrupts the save and lets the command proceed.
 */

import { describe, it, expect, vi } from "vitest";
import { OperationGate } from "../../src/util/operationGate";

// ---------------------------------------------------------------------------
// Helpers – lightweight stand-ins for the extension's upload infrastructure
// ---------------------------------------------------------------------------

interface FakeDoc {
  content: string;
  remoteName: string;
  port: string;
}

/**
 * Simulates the extension's uploadLiveDocument() function.
 * Resolves immediately unless a `stallMs` is given, in which case it waits
 * that many ms before resolving (to simulate a slow upload so the test can
 * interrupt it).
 */
function makeUploadFn(
  calls: Array<{ content: string; remoteName: string; signal: AbortSignal }>,
  stallMs = 0,
) {
  return async (doc: FakeDoc, signal: AbortSignal): Promise<void> => {
    calls.push({ content: doc.content, remoteName: doc.remoteName, signal });
    if (stallMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, stallMs));
    }
    // Honour the abort signal: exit silently if aborted (as uploadWithFallback does)
    if (signal.aborted) return;
  };
}

/** Builds a gate identical to the one in extension.ts activate(). */
function makeGate(interruptLog: string[] = []) {
  return new OperationGate({
    onInterrupt: async (name) => {
      interruptLog.push(name);
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OperationGate + live-edit save wiring", () => {
  // -------------------------------------------------------------------------
  // 1. Double-save: second save wins
  // -------------------------------------------------------------------------
  it("second save interrupts the first and the upload receives the second document's content", async () => {
    const calls: Array<{ content: string; remoteName: string; signal: AbortSignal }> = [];
    const interruptLog: string[] = [];
    const gate = makeGate(interruptLog);

    let releaseFirstUpload!: () => void;
    const stallForFirst = new Promise<void>((r) => { releaseFirstUpload = r; });

    const docA: FakeDoc = { content: "v1", remoteName: "init.lua", port: "COM7" };
    const docB: FakeDoc = { content: "v2", remoteName: "init.lua", port: "COM7" };

    // Simulate saving docA — upload stalls until we release it
    const saveA = gate.run("Save Live Device File", async (signal) => {
      calls.push({ content: docA.content, remoteName: docA.remoteName, signal });
      await stallForFirst; // slow upload
      if (!signal.aborted) calls[0].content = "v1-committed";
    });

    // Let docA's upload task start
    await new Promise((r) => setTimeout(r, 5));

    // Simulate saving docB — this should abort saveA
    const saveB = gate.run("Save Live Device File", async (signal) => {
      calls.push({ content: docB.content, remoteName: docB.remoteName, signal });
    });

    // Let the gate interrupt and saveB complete
    releaseFirstUpload(); // unblock saveA so it can finish and give way
    await Promise.allSettled([saveA, saveB]);

    // The interrupt was triggered for the first save
    expect(interruptLog).toContain("Save Live Device File");

    // The *second* call record must carry docB's content
    const lastCall = calls[calls.length - 1];
    expect(lastCall.content).toBe("v2");
    expect(lastCall.remoteName).toBe("init.lua");
  });

  // -------------------------------------------------------------------------
  // 2. AbortSignal is aborted when the gate is preempted
  // -------------------------------------------------------------------------
  it("the AbortSignal passed to the upload task is aborted when a new command runs", async () => {
    const gate = makeGate();
    let capturedSignal: AbortSignal | undefined;
    let releaseUpload!: () => void;

    // Slow live-edit save
    const save = gate.run("Save Live Device File", async (signal) => {
      capturedSignal = signal;
      await new Promise<void>((r) => { releaseUpload = r; });
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(capturedSignal?.aborted).toBe(false);

    // An "Upload File" command interrupts the save
    const uploadFile = gate.run("Upload File", async () => "uploaded");

    await new Promise((r) => setTimeout(r, 5));
    expect(capturedSignal?.aborted).toBe(true);

    releaseUpload();
    await save;
    await expect(uploadFile).resolves.toBe("uploaded");
  });

  // -------------------------------------------------------------------------
  // 3. Unrelated command interrupts an in-progress live-edit save
  // -------------------------------------------------------------------------
  it("an 'Upload File' command interrupts a live-edit save and runs to completion", async () => {
    const interruptLog: string[] = [];
    const gate = makeGate(interruptLog);
    const executedCommands: string[] = [];

    let releaseUpload!: () => void;

    // A slow live-edit save
    const save = gate.run("Save Live Device File", async () => {
      await new Promise<void>((r) => { releaseUpload = r; });
      executedCommands.push("Save Live Device File");
    });

    await new Promise((r) => setTimeout(r, 5));

    // User fires "Upload Changes" from the command palette
    const uploadChanges = gate.run("Upload Changes", async () => {
      executedCommands.push("Upload Changes");
      return "ok";
    });

    releaseUpload();
    await Promise.allSettled([save, uploadChanges]);

    expect(interruptLog).toContain("Save Live Device File");
    expect(executedCommands).toContain("Upload Changes");
    // The save task may or may not have committed depending on timing,
    // but the Upload Changes must always execute.
    expect(await uploadChanges).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // 4. A live-edit save that completes normally does NOT interrupt a subsequent one
  // -------------------------------------------------------------------------
  it("a finished save does not interrupt the next unrelated save", async () => {
    const interruptLog: string[] = [];
    const gate = makeGate(interruptLog);

    // Fast save A — completes before save B is started
    await gate.run("Save Live Device File", async () => { /* instant */ });

    // Fast save B — gate is idle, no interrupt expected
    await gate.run("Save Live Device File", async () => { /* instant */ });

    expect(interruptLog).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. onInterrupt is called with the name of the displaced task
  // -------------------------------------------------------------------------
  it("onInterrupt receives the exact name of the task that was running", async () => {
    const interruptLog: string[] = [];
    const gate = makeGate(interruptLog);

    let release!: () => void;
    const first = gate.run("MyCustomOperation", async () => {
      await new Promise<void>((r) => { release = r; });
    });

    await new Promise((r) => setTimeout(r, 5));

    const second = gate.run("AnotherOperation", async () => "done");

    release();
    await Promise.allSettled([first, second]);

    expect(interruptLog).toEqual(["MyCustomOperation"]);
  });

  // -------------------------------------------------------------------------
  // 6. Multiple rapid saves: content of the last one is what gets uploaded
  // -------------------------------------------------------------------------
  it("three rapid saves: upload is called with content of the third document", async () => {
    const uploadCalls: string[] = [];
    const interruptLog: string[] = [];
    const gate = makeGate(interruptLog);

    const makeUpload = (content: string, stallMs: number) =>
      gate.run("Save Live Device File", async (signal) => {
        await new Promise<void>((r) => setTimeout(r, stallMs));
        if (!signal.aborted) {
          uploadCalls.push(content);
        }
      });

    // Three saves fire in rapid succession; only the last should commit
    const a = makeUpload("v1", 50);
    const b = makeUpload("v2", 10);
    const c = makeUpload("v3", 5);

    await Promise.allSettled([a, b, c]);

    expect(uploadCalls).toContain("v3");
    // v1 was aborted by v2 which was aborted by v3, so v1 must not have committed
    expect(uploadCalls).not.toContain("v1");
  });
});
