import * as fs from "node:fs";
import { SerialPort } from "serialport";
import type { NodemcuToolOptions } from "./nodemcuTool";

export interface SerialUploadTransport {
  open(): Promise<void>;
  write(data: string | Buffer): Promise<void>;
  waitForPrompt(timeoutMs: number): Promise<string>;
  set?(options: { dtr?: boolean; rts?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export type SerialUploadTransportFactory = (port: string, baudRate: number) => SerialUploadTransport;

const PROMPT_TIMEOUT_MS = 6_000;
const OPEN_SETTLE_MS = 500;
const HEX_CHUNK_LENGTH = 232;
const TEMP_REMOTE_NAME = ".__nodemcu_upload_tmp";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation cancelled");
}

function luaString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function validateRemoteName(remoteName: string): void {
  if (
    remoteName.length === 0 ||
    remoteName.includes("\0") ||
    remoteName.includes("..") ||
    remoteName.startsWith("/") ||
    remoteName.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(remoteName)
  ) {
    throw new Error(`Unsafe remote file name: ${remoteName}`);
  }
}

export class SerialPortTransport implements SerialUploadTransport {
  private port: SerialPort | null = null;
  private buffer = "";

  constructor(private portName: string, private baudRate: number) {}

  async open(): Promise<void> {
    this.port = new SerialPort({ path: this.portName, baudRate: this.baudRate, autoOpen: false });
    this.port.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
    });
    await new Promise<void>((resolve, reject) => {
      this.port!.open((error) => error ? reject(error) : resolve());
    });
  }

  async write(data: string | Buffer): Promise<void> {
    if (!this.port) throw new Error("Serial port is not open");
    await new Promise<void>((resolve, reject) => {
      this.port!.write(data, (error) => error ? reject(error) : resolve());
    });
    await new Promise<void>((resolve, reject) => {
      this.port!.drain((error) => error ? reject(error) : resolve());
    });
  }

  async waitForPrompt(timeoutMs: number): Promise<string> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (/(^|[\r\n])>\s*$/.test(this.buffer) || this.buffer.trimEnd().endsWith(">")) {
        const out = this.buffer;
        this.buffer = "";
        return out;
      }
      await delay(50);
    }
    throw new Error("Timed out waiting for NodeMCU prompt");
  }

  async set(options: { dtr?: boolean; rts?: boolean }): Promise<void> {
    if (!this.port) throw new Error("Serial port is not open");
    await new Promise<void>((resolve, reject) => {
      this.port!.set(options, (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    if (!this.port || !this.port.isOpen) {
      this.port = null;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.port!.close((error) => error ? reject(error) : resolve());
    });
    this.port = null;
  }
}

export class DirectSerialUploader {
  constructor(
    private createTransport: SerialUploadTransportFactory = (port, baudRate) => new SerialPortTransport(port, baudRate),
  ) {}

  async upload(
    opts: NodemcuToolOptions,
    localPath: string,
    remoteName: string,
    onLog: (s: string) => void,
  ): Promise<{ success: boolean; error?: string }> {
    let lastError = "";
    const baudRates = Array.from(new Set([opts.baud, opts.baudUpload].filter((baud) => baud > 0)));
    for (const baudRate of baudRates) {
      throwIfAborted(opts.signal);
      const result = await this.uploadAtBaud(opts, baudRate, localPath, remoteName, onLog);
      if (result.success) return result;
      lastError = result.error ?? lastError;
      onLog(`Direct serial upload at ${baudRate} baud failed: ${lastError}\n`);
    }
    return { success: false, error: lastError || "Direct serial upload failed" };
  }

  private async uploadAtBaud(
    opts: NodemcuToolOptions,
    baudRate: number,
    localPath: string,
    remoteName: string,
    onLog: (s: string) => void,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      validateRemoteName(remoteName);
      const content = fs.readFileSync(localPath);
      const transport = this.createTransport(opts.port, baudRate);
      try {
        throwIfAborted(opts.signal);
        await this.connectToPrompt(transport);
        await this.execute(transport, `file.remove(${luaString(TEMP_REMOTE_NAME)})`);
        await this.execute(transport, `file.open(${luaString(TEMP_REMOTE_NAME)},"w+")`);
        await this.execute(transport, `_G.__vscode_hex=function(s) for c in s:gmatch('..') do file.write(string.char(tonumber(c,16))) end end`);
        const hex = content.toString("hex");
        for (let i = 0; i < hex.length; i += HEX_CHUNK_LENGTH) {
          throwIfAborted(opts.signal);
          await this.execute(transport, `__vscode_hex(${luaString(hex.slice(i, i + HEX_CHUNK_LENGTH))})`);
        }
        await this.execute(transport, "file.flush() file.close()");
        await this.execute(transport, `file.remove(${luaString(remoteName)})`);
        await this.execute(transport, `file.rename(${luaString(TEMP_REMOTE_NAME)},${luaString(remoteName)})`);
        if (opts.compile && remoteName.toLowerCase().endsWith(".lua")) {
          await this.execute(transport, `node.compile(${luaString(remoteName)})`);
          await this.execute(transport, `file.remove(${luaString(remoteName)})`);
        }
        onLog(`Direct serial upload complete at ${baudRate} baud: ${remoteName}\n`);
        return { success: true };
      } finally {
        await transport.close().catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async hardReset(opts: NodemcuToolOptions, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const transport = this.createTransport(opts.port, opts.baudUpload || opts.baud);
    try {
      await transport.open();
      if (!transport.set) throw new Error("Serial transport does not support DTR/RTS reset");
      await transport.set({ dtr: false, rts: true });
      await delay(100);
      await transport.set({ dtr: false, rts: false });
      onLog("Direct serial hard reset complete.\n");
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    } finally {
      await transport.close().catch(() => {});
      if (process.platform === "win32") {
        await delay(1500);
      }
    }
  }

  async download(
    opts: NodemcuToolOptions,
    remoteName: string,
    onLog: (s: string) => void,
  ): Promise<{ success: boolean; content?: Buffer; error?: string }> {
    let lastError = "";
    const baudRates = Array.from(new Set([opts.baud, opts.baudUpload].filter((baud) => baud > 0)));
    for (const baudRate of baudRates) {
      throwIfAborted(opts.signal);
      const result = await this.downloadAtBaud(opts, baudRate, remoteName, onLog);
      if (result.success) return result;
      lastError = result.error ?? lastError;
      onLog(`Direct serial download at ${baudRate} baud failed: ${lastError}\n`);
    }
    return { success: false, error: lastError || "Direct serial download failed" };
  }

  private async downloadAtBaud(
    opts: NodemcuToolOptions,
    baudRate: number,
    remoteName: string,
    onLog: (s: string) => void,
  ): Promise<{ success: boolean; content?: Buffer; error?: string }> {
    try {
      validateRemoteName(remoteName);
      const transport = this.createTransport(opts.port, baudRate);
      try {
        await this.connectToPrompt(transport);
        const output = await this.execute(
          transport,
          [
            `uart.write(0,"__VSCODE_BEGIN__")`,
            `if file.open(${luaString(remoteName)},"r") then`,
            `repeat local c=file.read(64) if c then for i=1,#c do uart.write(0,string.format("%02x",string.byte(c,i))) end end until not c`,
            `file.close() end`,
            `uart.write(0,"__VSCODE_END__")`,
          ].join(" "),
        );
        const match = output.match(/__VSCODE_BEGIN__([0-9a-fA-F]*)__VSCODE_END__/s);
        if (!match) throw new Error("Unable to read remote file content");
        onLog(`Direct serial download complete at ${baudRate} baud: ${remoteName}\n`);
        return { success: true, content: Buffer.from(match[1], "hex") };
      } finally {
        await transport.close().catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  private async connectToPrompt(transport: SerialUploadTransport): Promise<void> {
    await transport.open();
    await delay(OPEN_SETTLE_MS);
    await transport.write("\r\n");
    try {
      await transport.waitForPrompt(PROMPT_TIMEOUT_MS);
      return;
    } catch {
      if (!transport.set) throw new Error("Timed out waiting for NodeMCU prompt");
    }
    await transport.set({ dtr: false, rts: true });
    await delay(100);
    await transport.set({ dtr: false, rts: false });
    await delay(2500);
    await transport.write("\r\n\r\n");
    await transport.waitForPrompt(PROMPT_TIMEOUT_MS);
  }

  private async execute(transport: SerialUploadTransport, command: string): Promise<string> {
    await transport.write(`${command}\r\n`);
    return await transport.waitForPrompt(PROMPT_TIMEOUT_MS);
  }
}
