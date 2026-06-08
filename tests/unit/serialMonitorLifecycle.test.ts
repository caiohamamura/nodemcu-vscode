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

  it("closes NodeMCU serial monitors and records ports for restart", async () => {
    const monitor = fakeTerminal("NodeMCU: COM7");
    const other = fakeTerminal("PowerShell");
    mockWindow.terminals.push(monitor, other);

    const closed = await closeSerialMonitors();

    expect(closed).toEqual([{ name: "NodeMCU: COM7", port: "COM7" }]);
    expect(monitor.sent).toEqual([{ text: "\x03", addNewLine: false }]);
    expect(monitor.disposed).toBe(true);
    expect(other.disposed).toBe(false);
  });

  it("restores previously open serial monitors after live-save upload", async () => {
    const closed: ClosedSerialMonitor[] = [{ name: "NodeMCU: COM7", port: "COM7" }];

    await restoreSerialMonitors(closed);

    expect(mockWindow.createdTerminals).toHaveLength(1);
    expect(mockWindow.createdTerminals[0].name).toBe("NodeMCU: COM7");
    expect(mockWindow.createdTerminals[0].shown).toBe(true);
    expect(mockWindow.createdTerminals[0].shellPath).toBe("python");
    expect(mockWindow.createdTerminals[0].shellArgs).toEqual(["-m", "serial.tools.miniterm", "COM7", "115200"]);
    expect(mockWindow.createdTerminals[0].sent).toEqual([]);
  });

  it("does not restore serial monitors after an aborted save", async () => {
    const controller = new AbortController();
    controller.abort();

    await restoreSerialMonitors([{ name: "NodeMCU: COM7", port: "COM7" }], controller.signal);

    expect(mockWindow.createdTerminals).toHaveLength(0);
  });
});
