import * as vscode from "vscode";
import { SerialCursor, type SerialMatch, type WaitOptions } from "./serialCursor";
import { SerialRingBuffer, type SerialChunk } from "./serialBuffer";
import { SERIAL_PATTERNS, type SerialDeviceEvent } from "./serialPatterns";

type SerialPortConstructor = typeof import("serialport").SerialPort;
type SerialPortHandle = InstanceType<SerialPortConstructor>;

let serialPortConstructorPromise: Promise<SerialPortConstructor> | undefined;

async function getSerialPortConstructor(): Promise<SerialPortConstructor> {
  serialPortConstructorPromise ??= import("serialport").then((module) => module.SerialPort);
  return await serialPortConstructorPromise;
}

export type SerialSessionState =
  | "closed"
  | "opening"
  | "open"
  | "booting"
  | "ready"
  | "busy"
  | "released-for-flash"
  | "error";

export interface CommandOptions {
  timeoutMs?: number;
  waitForPrompt?: boolean;
  signal?: AbortSignal;
}

export interface CommandResult {
  output: string;
  success: boolean;
}

export class SerialSession implements vscode.Disposable {
  readonly port: string;
  readonly baudRate: number;

  private readonly buffer = new SerialRingBuffer({
    maxBytes: 2 * 1024 * 1024,
    maxAgeMs: 10 * 60_000,
  });
  private readonly onDataEmitter = new vscode.EventEmitter<SerialChunk>();
  private readonly onLineEmitter = new vscode.EventEmitter<string>();
  private readonly onStateChangedEmitter = new vscode.EventEmitter<SerialSessionState>();
  private readonly onDeviceEventEmitter = new vscode.EventEmitter<SerialDeviceEvent>();

  readonly onData = this.onDataEmitter.event;
  readonly onLine = this.onLineEmitter.event;
  readonly onStateChanged = this.onStateChangedEmitter.event;
  readonly onDeviceEvent = this.onDeviceEventEmitter.event;

  private portHandle: SerialPortHandle | null = null;
  private state: SerialSessionState = "closed";
  private openPromise: Promise<void> | null = null;
  private sequence = 0;
  private lineBuffer = "";
  private writeChain: Promise<void> = Promise.resolve();
  private exclusiveChain: Promise<void> = Promise.resolve();
  private activeExclusiveCount = 0;

  constructor(port: string, baudRate: number) {
    this.port = port;
    this.baudRate = baudRate;
  }

  dispose(): void {
    void this.close();
    this.onDataEmitter.dispose();
    this.onLineEmitter.dispose();
    this.onStateChangedEmitter.dispose();
    this.onDeviceEventEmitter.dispose();
  }

  getState(): SerialSessionState {
    return this.state;
  }

  latestSeq(): number {
    return this.buffer.latestSeq();
  }

  snapshot(fromSeq = 0): SerialChunk[] {
    return this.buffer.snapshot(fromSeq);
  }

  clearBuffer(): void {
    this.buffer.clear();
    this.lineBuffer = "";
  }

  async open(): Promise<void> {
    if (this.portHandle?.isOpen) {
      if (this.state === "closed" || this.state === "released-for-flash") {
        this.setState("open");
      }
      return;
    }
    if (this.openPromise) {
      return await this.openPromise;
    }

    this.setState("opening");
    this.openPromise = (async () => {
      const SerialPort = await getSerialPortConstructor();
      await new Promise<void>((resolve, reject) => {
      let port: SerialPortHandle;
      try {
        port = new SerialPort({ path: this.port, baudRate: this.baudRate, autoOpen: false });
      } catch (error) {
        this.setState("error");
        reject(error);
        return;
      }

      const handleError = (error: Error): void => {
        this.setState("error");
        rejectOnce(error);
      };
      const handleClose = (): void => {
        this.portHandle = null;
        this.setState(this.state === "released-for-flash" ? "released-for-flash" : "closed");
      };
      const handleData = (chunk: Buffer): void => {
        this.handleIncomingChunk(chunk);
      };

      let settled = false;
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        port.removeListener("data", handleData);
        port.removeListener("error", handleError);
        port.removeListener("close", handleClose);
        try {
          if (port.isOpen) {
            port.close(() => undefined);
          } else {
            port.destroy();
          }
        } catch {
          // Ignore cleanup errors on a failed open path.
        }
        this.portHandle = null;
        reject(error);
      };

      port.on("data", handleData);
      port.on("error", handleError);
      port.on("close", handleClose);
      port.open((error) => {
        if (error) {
          this.setState("error");
          rejectOnce(error);
          return;
        }
        settled = true;
        this.portHandle = port;
        this.setState("open");
        resolve();
      });
      });
    })().finally(() => {
      this.openPromise = null;
    });

    return await this.openPromise;
  }

  async close(): Promise<void> {
    const port = this.portHandle;
    this.portHandle = null;
    this.openPromise = null;
    if (!port) {
      if (this.state !== "released-for-flash") {
        this.setState("closed");
      }
      return;
    }

    await new Promise<void>((resolve) => {
      try {
        if (!port.isOpen) {
          port.removeAllListeners();
          port.destroy();
          resolve();
          return;
        }
        port.close(() => {
          port.removeAllListeners();
          port.destroy();
          resolve();
        });
      } catch {
        try {
          port.removeAllListeners();
          port.destroy();
        } catch {
          // Ignore finalizer errors.
        }
        resolve();
      }
    });

    if (this.state !== "released-for-flash") {
      this.setState("closed");
    }
  }

  markReleasedForFlash(): void {
    this.setState("released-for-flash");
  }

  createCursor(options?: { includeHistory?: boolean }): SerialCursor {
    return new SerialCursor(this.buffer, options);
  }

  async write(data: string | Buffer, options?: { signal?: AbortSignal }): Promise<void> {
    await this.open();
    await this.enqueueWrite(async () => {
      throwIfAborted(options?.signal);
      const port = this.portHandle;
      if (!port?.isOpen) {
        throw new Error(`Serial port ${this.port} is not open`);
      }
      await new Promise<void>((resolve, reject) => {
        port.write(data, (error) => {
          if (error) {
            reject(error);
            return;
          }
          port.drain((drainError) => drainError ? reject(drainError) : resolve());
        });
      });
    });
  }

  async sendCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    return await this.runExclusive("Serial command", async (cursor) => {
      const startSeq = cursor.latestSeq();
      await this.write(`${command}\r\n`, { signal: options.signal });
      if (options.waitForPrompt === false) {
        return {
          output: this.buffer.textSince(startSeq),
          success: true,
        };
      }
      const match = await cursor.waitFor(SERIAL_PATTERNS.luaPrompt, {
        timeoutMs: options.timeoutMs ?? 6_000,
        signal: options.signal,
      });
      return { output: match.text, success: true };
    });
  }

  async waitFor(pattern: RegExp | string, options: WaitOptions): Promise<SerialMatch> {
    const cursor = this.createCursor({ includeHistory: options.includeHistory });
    return await cursor.waitFor(pattern, options);
  }

  async runExclusive<T>(
    _name: string,
    fn: (cursor: SerialCursor) => Promise<T>,
  ): Promise<T> {
    const previous = this.exclusiveChain.catch(() => {});
    let releaseGate!: () => void;
    this.exclusiveChain = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    await previous;
    this.activeExclusiveCount += 1;
    await this.open();
    this.setState("busy");
    const cursor = this.createCursor();

    try {
      return await fn(cursor);
    } finally {
      this.activeExclusiveCount -= 1;
      releaseGate();
      this.setState(this.activeExclusiveCount > 0 ? "busy" : "ready");
    }
  }

  async reset(mode: "soft" | "hard" = "hard"): Promise<void> {
    await this.open();
    if (mode === "soft") {
      this.setState("booting");
      await this.write("node.restart()\r\n");
      return;
    }

    const port = this.portHandle;
    if (!port?.isOpen) {
      throw new Error(`Serial port ${this.port} is not open`);
    }
    this.setState("booting");
    await new Promise<void>((resolve, reject) => {
      port.set({ dtr: false, rts: true }, (error) => error ? reject(error) : resolve());
    });
    await delay(100);
    await new Promise<void>((resolve, reject) => {
      port.set({ dtr: false, rts: false }, (error) => error ? reject(error) : resolve());
    });
  }

  private async enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(fn);
    this.writeChain = next.catch(() => {});
    await next;
  }

  private handleIncomingChunk(chunk: Buffer): void {
    const text = chunk.toString("utf-8");
    const item: SerialChunk = {
      seq: ++this.sequence,
      timestamp: Date.now(),
      data: Buffer.from(chunk),
      text,
    };
    this.buffer.append(item);
    this.onDataEmitter.fire(item);
    this.emitLines(text);
    this.emitDeviceEvents(item);
  }

  private emitLines(text: string): void {
    this.lineBuffer += text;
    while (true) {
      const newlineIndex = this.lineBuffer.search(/[\r\n]/);
      if (newlineIndex < 0) {
        return;
      }

      const line = this.lineBuffer.slice(0, newlineIndex);
      const nextIndex = this.lineBuffer.startsWith("\r\n", newlineIndex) ? newlineIndex + 2 : newlineIndex + 1;
      this.lineBuffer = this.lineBuffer.slice(nextIndex);
      this.onLineEmitter.fire(line);
    }
  }

  private emitDeviceEvents(chunk: SerialChunk): void {
    if (SERIAL_PATTERNS.panic.test(chunk.text)) {
      this.onDeviceEventEmitter.fire({ type: "panic", text: chunk.text });
    }
    if (SERIAL_PATTERNS.bootBanner.test(chunk.text) || SERIAL_PATTERNS.bootMode.test(chunk.text)) {
      this.onDeviceEventEmitter.fire({ type: "boot-start", text: chunk.text });
    }
    if (SERIAL_PATTERNS.luaPrompt.test(chunk.text)) {
      this.setState(this.activeExclusiveCount > 0 ? "busy" : "ready");
      this.onDeviceEventEmitter.fire({ type: "lua-prompt", text: chunk.text });
    }
    if (SERIAL_PATTERNS.vscodeBegin.test(chunk.text)) {
      this.onDeviceEventEmitter.fire({ type: "vscode-marker", marker: "begin", text: chunk.text });
    }
    if (SERIAL_PATTERNS.vscodeEnd.test(chunk.text)) {
      this.onDeviceEventEmitter.fire({ type: "vscode-marker", marker: "end", text: chunk.text });
    }
  }

  private setState(next: SerialSessionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.onStateChangedEmitter.fire(next);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation cancelled");
  }
}
