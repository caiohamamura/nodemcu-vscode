import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { closeSerialMonitors, restoreSerialMonitors, type ClosedSerialMonitor } from "../../src/extension";

const mockWindow = vscode.window as unknown as {
  terminals: Array<{
    name: string;
    processId?: Promise<number | undefined>;
    sent: Array<{ text: string; addNewLine?: boolean }>;
    disposed: boolean;
    sendText(text: string, addNewLine?: boolean): void;
    dispose(): void;
  }>;
  createdTerminals: Array<{
    name: string;
    shellPath?: string;
    shellArgs?: string[];
    sent: Array<{ text: string; addNewLine?: boolean }>;
    shown: boolean;
  }>;
};

function fakeTerminal(name: string) {
  return {
    name,
    processId: Promise.resolve(undefined),
    sent: [] as Array<{ text: string; addNewLine?: boolean }>,
    disposed: false,
    sendText(text: string, addNewLine?: boolean): void {
      this.sent.push({ text, addNewLine });
    },
    dispose(): void {
      this.disposed = true;
    },
  };
}

describe("serial monitor lifecycle", () => {
  beforeEach(() => {
    mockWindow.terminals.length = 0;
    mockWindow.createdTerminals.length = 0;
  });

  it("does not manage external terminals anymore", async () => {
    const monitor = fakeTerminal("NodeMCU: COM7");
    const other = fakeTerminal("PowerShell");
    mockWindow.terminals.push(monitor, other);

    const closed = await closeSerialMonitors();

    expect(closed).toEqual([]);
    expect(monitor.sent).toEqual([]);
    expect(monitor.disposed).toBe(false);
    expect(other.disposed).toBe(false);
  });

  it("restoreSerialMonitors is a no-op with the shared serial console", async () => {
    const closed: ClosedSerialMonitor[] = [{ name: "NodeMCU: COM7", port: "COM7" }];

    await restoreSerialMonitors(closed);

    expect(mockWindow.createdTerminals).toHaveLength(0);
  });

  it("still does nothing when aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await restoreSerialMonitors([{ name: "NodeMCU: COM7", port: "COM7" }], controller.signal);

    expect(mockWindow.createdTerminals).toHaveLength(0);
  });
});
