import * as fs from "node:fs";
import { SerialPort } from "serialport";
import type { FileEntry, NodemcuToolOptions } from "./nodemcuTool";

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
const BEGIN_MARKER = "__VSCODE_BEGIN__";
const END_MARKER = "__VSCODE_END__";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation cancelled");
}

function luaString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function luaError(output: string): string | null {
  const lines = output
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== ">");
  const line = lines.find((candidate) =>
    /^(stdin:\d+:|[\w./\\-]+\.lua:\d+:|PANIC:|lua:)/i.test(candidate)
  );
  return line ? `NodeMCU reported: ${line}` : null;
}

function extractMarkedPayload(output: string): string | null {
  const end = output.lastIndexOf(END_MARKER);
  if (end < 0) return null;
  const begin = output.lastIndexOf(BEGIN_MARKER, end);
  if (begin < 0) return null;
  return output.slice(begin + BEGIN_MARKER.length, end);
}

function sourceNameForCompiledUpload(remoteName: string): string {
  if (/\.lc$/i.test(remoteName)) return `${remoteName.slice(0, -3)}.lua`;
  if (/\.lua$/i.test(remoteName)) return remoteName;
  return `${remoteName}.lua`;
}

function compiledNameForSource(sourceName: string): string {
  return sourceName.replace(/\.lua$/i, ".lc");
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
    const port = this.port;
    if (!port) {
      return;
    }
    this.port = null;
    if (!port.isOpen) {
      port.removeAllListeners();
      port.destroy();
      this.buffer = "";
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        port.close((error) => error ? reject(error) : resolve());
      });
    } finally {
      port.removeAllListeners();
      port.destroy();
      this.buffer = "";
    }
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
    for (const baudRate of this.baudRates(opts)) {
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
      const uploadName = opts.compile ? sourceNameForCompiledUpload(remoteName) : remoteName;
      const compiledName = opts.compile ? compiledNameForSource(uploadName) : null;
      validateRemoteName(uploadName);
      if (compiledName) validateRemoteName(compiledName);
      const content = fs.readFileSync(localPath);
      const transport = this.createTransport(opts.port, baudRate);
      try {
        throwIfAborted(opts.signal);
        await this.connectToPrompt(transport);
        await this.execute(transport, `file.remove(${luaString(TEMP_REMOTE_NAME)})`);
        await this.execute(transport, `assert(file.open(${luaString(TEMP_REMOTE_NAME)},"w+"))`);
        await this.execute(transport, `_G.__vscode_hex=function(s) for c in s:gmatch('..') do file.write(string.char(tonumber(c,16))) end end`);
        const hex = content.toString("hex");
        for (let i = 0; i < hex.length; i += HEX_CHUNK_LENGTH) {
          throwIfAborted(opts.signal);
          await this.execute(transport, `__vscode_hex(${luaString(hex.slice(i, i + HEX_CHUNK_LENGTH))})`);
        }
        await this.execute(transport, "file.flush() file.close()");
        await this.execute(transport, `file.remove(${luaString(uploadName)})`);
        if (compiledName) await this.execute(transport, `file.remove(${luaString(compiledName)})`);
        await this.execute(transport, `assert(file.rename(${luaString(TEMP_REMOTE_NAME)},${luaString(uploadName)}))`);
        if (compiledName) {
          await this.execute(transport, `node.compile(${luaString(uploadName)})`);
          await this.execute(transport, `file.remove(${luaString(uploadName)})`);
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
    for (const baudRate of this.baudRates(opts)) {
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
            `uart.write(0,${luaString(BEGIN_MARKER)})`,
            `if file.open(${luaString(remoteName)},"r") then`,
            `uart.write(0,"OK:")`,
            `repeat local c=file.read(64) if c then for i=1,#c do uart.write(0,string.format("%02x",string.byte(c,i))) end end until not c`,
            `file.close() else uart.write(0,"ERR:open") end`,
            `uart.write(0,${luaString(END_MARKER)})`,
          ].join(" "),
        );
        const payload = extractMarkedPayload(output);
        if (!payload?.startsWith("OK:")) throw new Error(`Unable to read remote file: ${remoteName}`);
        onLog(`Direct serial download complete at ${baudRate} baud: ${remoteName}\n`);
        return { success: true, content: Buffer.from(payload.slice(3), "hex") };
      } finally {
        await transport.close().catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async listFiles(
    opts: NodemcuToolOptions,
    onLog: (s: string) => void,
  ): Promise<{ success: boolean; files?: FileEntry[]; error?: string }> {
    let lastError = "";
    for (const baudRate of this.baudRates(opts)) {
      throwIfAborted(opts.signal);
      const result = await this.listFilesAtBaud(opts, baudRate, onLog);
      if (result.success) return result;
      lastError = result.error ?? lastError;
      onLog(`Direct serial file listing at ${baudRate} baud failed: ${lastError}\n`);
    }
    return { success: false, error: lastError || "Direct serial file listing failed" };
  }

  private async listFilesAtBaud(
    opts: NodemcuToolOptions,
    baudRate: number,
    onLog: (s: string) => void,
  ): Promise<{ success: boolean; files?: FileEntry[]; error?: string }> {
    try {
      const transport = this.createTransport(opts.port, baudRate);
      try {
        await this.connectToPrompt(transport);
        const output = await this.execute(
          transport,
          [
            `uart.write(0,${luaString(BEGIN_MARKER)})`,
            `for name,size in pairs(file.list()) do`,
            `for i=1,#name do uart.write(0,string.format("%02x",string.byte(name,i))) end`,
            `uart.write(0,string.char(9),tostring(size),string.char(10))`,
            `end`,
            `uart.write(0,${luaString(END_MARKER)})`,
          ].join(" "),
        );
        const payload = extractMarkedPayload(output);
        if (payload === null) throw new Error("Unable to read remote file list");
        const files = payload
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => {
            const [hexName, sizeText = "0"] = line.split("\t");
            if (!/^[0-9a-fA-F]+$/.test(hexName)) throw new Error("Invalid remote file list response");
            return {
              name: Buffer.from(hexName, "hex").toString("utf-8"),
              size: Number(sizeText) || 0,
            };
          });
        onLog(`Direct serial file listing complete at ${baudRate} baud.\n`);
        return { success: true, files };
      } finally {
        await transport.close().catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async remove(opts: NodemcuToolOptions, remoteName: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    let lastError = "";
    for (const baudRate of this.baudRates(opts)) {
      throwIfAborted(opts.signal);
      const result = await this.removeAtBaud(opts, baudRate, remoteName, onLog);
      if (result.success) return result;
      lastError = result.error ?? lastError;
      onLog(`Direct serial delete at ${baudRate} baud failed: ${lastError}\n`);
    }
    return { success: false, error: lastError || "Direct serial delete failed" };
  }

  private async removeAtBaud(
    opts: NodemcuToolOptions,
    baudRate: number,
    remoteName: string,
    onLog: (s: string) => void,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      validateRemoteName(remoteName);
      const transport = this.createTransport(opts.port, baudRate);
      try {
        await this.connectToPrompt(transport);
        await this.execute(transport, `file.remove(${luaString(remoteName)})`);
        onLog(`Direct serial delete complete at ${baudRate} baud: ${remoteName}\n`);
        return { success: true };
      } finally {
        await transport.close().catch(() => {});
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async runFile(opts: NodemcuToolOptions, remoteName: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    let lastError = "";
    for (const baudRate of this.baudRates(opts)) {
      throwIfAborted(opts.signal);
      const result = await this.runFileAtBaud(opts, baudRate, remoteName, onLog);
      if (result.success) return result;
      lastError = result.error ?? lastError;
      onLog(`Direct serial run at ${baudRate} baud failed: ${lastError}\n`);
    }
    return { success: false, error: lastError || "Direct serial run failed" };
  }

  private async runFileAtBaud(
    opts: NodemcuToolOptions,
    baudRate: number,
    remoteName: string,
    onLog: (s: string) => void,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      validateRemoteName(remoteName);
      const transport = this.createTransport(opts.port, baudRate);
      try {
        await this.connectToPrompt(transport);
        const output = await this.execute(transport, `dofile(${luaString(remoteName)})`);
        onLog(output);
        onLog(`Direct serial run complete at ${baudRate} baud: ${remoteName}\n`);
        return { success: true };
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
    const output = await transport.waitForPrompt(PROMPT_TIMEOUT_MS);
    const error = luaError(output);
    if (error) throw new Error(error);
    return output;
  }

  private baudRates(opts: NodemcuToolOptions): number[] {
    return Array.from(new Set([opts.baud, opts.baudUpload].filter((baud) => baud > 0)));
  }
}
