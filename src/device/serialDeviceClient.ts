import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { SerialSession } from "../serial/serialSession";
import { SERIAL_PATTERNS, waitForBoot, waitForLuaPrompt } from "../serial/serialPatterns";
import type { SerialCursor } from "../serial/serialCursor";
import type { FileEntry } from "../upload/nodemcuTool";
import { validateRemoteName } from "../upload/directSerialUploader";

const PROMPT_TIMEOUT_MS = 6_000;
const BOOT_TIMEOUT_MS = 10_000;
const MKFS_TIMEOUT_MS = 45_000;
const HEX_CHUNK_LENGTH = 232;
const TEMP_REMOTE_NAME = ".__nodemcu_upload_tmp";

export interface Result {
  success: boolean;
  error?: string;
}

export interface UploadOptions {
  compile?: boolean;
  signal?: AbortSignal;
}

export class SerialDeviceClient {
  constructor(private readonly session: SerialSession) {}

  async upload(localPath: string, remoteName: string, options: UploadOptions = {}): Promise<Result> {
    const content = fs.readFileSync(localPath);
    return await this.uploadContent(content, remoteName, options);
  }

  async uploadContent(content: Uint8Array, remoteName: string, options: UploadOptions = {}): Promise<Result> {
    try {
      await this.session.runExclusive(`Upload ${remoteName}`, async (cursor) => {
        const uploadName = options.compile ? sourceNameForCompiledUpload(remoteName) : remoteName;
        const compiledName = options.compile ? compiledNameForSource(uploadName) : null;
        validateRemoteName(uploadName);
        if (compiledName) {
          validateRemoteName(compiledName);
        }

        await this.ensurePrompt(cursor);
        await this.execute(cursor, `file.remove(${luaString(TEMP_REMOTE_NAME)})`, options.signal);
        await this.execute(cursor, `assert(file.open(${luaString(TEMP_REMOTE_NAME)},"w+"))`, options.signal);
        await this.execute(
          cursor,
          `_G.__vscode_hex=function(s) for c in s:gmatch('..') do file.write(string.char(tonumber(c,16))) end end`,
          options.signal,
        );

        const hex = Buffer.from(content).toString("hex");
        for (let index = 0; index < hex.length; index += HEX_CHUNK_LENGTH) {
          throwIfAborted(options.signal);
          await this.execute(cursor, `__vscode_hex(${luaString(hex.slice(index, index + HEX_CHUNK_LENGTH))})`, options.signal);
        }

        await this.execute(cursor, "file.flush() file.close()", options.signal);
        await this.execute(cursor, `file.remove(${luaString(uploadName)})`, options.signal);
        if (compiledName) {
          await this.execute(cursor, `file.remove(${luaString(compiledName)})`, options.signal);
        }
        await this.execute(cursor, `assert(file.rename(${luaString(TEMP_REMOTE_NAME)},${luaString(uploadName)}))`, options.signal);
        if (compiledName) {
          await this.execute(cursor, `node.compile(${luaString(uploadName)})`, options.signal);
          await this.execute(cursor, `file.remove(${luaString(uploadName)})`, options.signal);
        }
      });
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  }

  async download(remoteName: string): Promise<{ success: boolean; content?: Buffer; error?: string }> {
    try {
      validateRemoteName(remoteName);
      const content = await this.session.runExclusive(`Download ${remoteName}`, async (cursor) => {
        await this.ensurePrompt(cursor);
        await this.execute(
          cursor,
          `_G.__vscode_hex_of_string=function(s) local out="" for i=1,#s do out=out..string.format("%02x",string.byte(s,i)) end return out end`,
        );
        const { begin, end, id } = createMarkers();
        const output = await this.execute(
          cursor,
          [
            `uart.write(0,${luaString(begin)});`,
            `if file.open(${luaString(remoteName)},"r") then`,
            `local out="OK:";`,
            `while true do local c=file.read(64); if not c then break end out=out..__vscode_hex_of_string(c) end;`,
            `file.close(); uart.write(0,out); else uart.write(0,"ERR:open"); end;`,
            `uart.write(0,${luaString(end)})`,
          ].join(" "),
        );
        const payload = extractMarkedPayload(output, begin, end);
        if (!payload?.startsWith("OK:")) {
          throw new Error(`Unable to read remote file: ${remoteName} (${id})`);
        }
        return Buffer.from(payload.slice(3), "hex");
      });
      return { success: true, content };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listFiles(): Promise<{ success: boolean; files?: FileEntry[]; error?: string }> {
    try {
      const files = await this.session.runExclusive("List files", async (cursor) => {
        await this.ensurePrompt(cursor);
        await this.execute(
          cursor,
          `_G.__vscode_hex_of_string=function(s) local out="" for i=1,#s do out=out..string.format("%02x",string.byte(s,i)) end return out end`,
        );
        const { begin, end, id } = createMarkers();
        const output = await this.execute(
          cursor,
          [
            `uart.write(0,${luaString(begin)});`,
            `for name,size in pairs(file.list()) do`,
            `print(__vscode_hex_of_string(name)..string.char(9)..tostring(size));`,
            `end;`,
            `uart.write(0,${luaString(end)})`,
          ].join(" "),
        );
        const payload = extractMarkedPayload(output, begin, end);
        if (payload === null) {
          throw new Error(`Unable to read remote file list (${id})`);
        }
        return payload
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => {
            const [hexName, sizeText = "0"] = line.split("\t");
            if (!/^[0-9a-fA-F]+$/.test(hexName)) {
              throw new Error("Invalid remote file list response");
            }
            return {
              name: Buffer.from(hexName, "hex").toString("utf-8"),
              size: Number(sizeText) || 0,
            };
          });
      });
      return { success: true, files };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async remove(remoteName: string): Promise<Result> {
    try {
      validateRemoteName(remoteName);
      await this.session.runExclusive(`Remove ${remoteName}`, async (cursor) => {
        await this.ensurePrompt(cursor);
        await this.execute(cursor, `file.remove(${luaString(remoteName)})`);
      });
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  }

  async runFile(remoteName: string): Promise<Result> {
    try {
      validateRemoteName(remoteName);
      await this.session.runExclusive(`Run ${remoteName}`, async (cursor) => {
        await this.ensurePrompt(cursor);
        await this.execute(cursor, `dofile(${luaString(remoteName)})`);
      });
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  }

  async mkfs(): Promise<Result> {
    try {
        await this.session.runExclusive("Format filesystem", async (cursor) => {
          await this.ensurePrompt(cursor);
        await this.execute(cursor, "file.format(); print('__VSCODE_MKFS_OK__')", undefined, MKFS_TIMEOUT_MS);
      });
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  }

  async reset(): Promise<Result> {
    try {
      await this.session.runExclusive("Reset device", async (cursor) => {
        await this.session.reset("hard");
        await waitForBoot(this.session, cursor, BOOT_TIMEOUT_MS);
        await waitForLuaPrompt(this.session, cursor, PROMPT_TIMEOUT_MS);
      });
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  }

  private async ensurePrompt(cursor: SerialCursor): Promise<void> {
    try {
      await waitForLuaPrompt(this.session, cursor, 2_000);
    } catch {
      await this.session.reset("hard");
      await waitForBoot(this.session, cursor, BOOT_TIMEOUT_MS);
      await waitForLuaPrompt(this.session, cursor, PROMPT_TIMEOUT_MS);
    }
  }

  private async execute(
    cursor: SerialCursor,
    command: string,
    signal?: AbortSignal,
    timeoutMs = PROMPT_TIMEOUT_MS,
  ): Promise<string> {
    throwIfAborted(signal);
    await this.session.write(`${command}\r\n`, { signal });
    const output = await cursor.waitFor(SERIAL_PATTERNS.luaPrompt, { timeoutMs, signal });
    const error = luaError(output.text);
    if (error) {
      throw new Error(error);
    }
    return output.text;
  }
}

function createMarkers(): { id: string; begin: string; end: string } {
  const id = randomUUID().replace(/-/g, "");
  return {
    id,
    begin: `__VSCODE_BEGIN_${id}__`,
    end: `__VSCODE_END_${id}__`,
  };
}

function sourceNameForCompiledUpload(remoteName: string): string {
  if (/\.lc$/i.test(remoteName)) return `${remoteName.slice(0, -3)}.lua`;
  if (/\.lua$/i.test(remoteName)) return remoteName;
  return `${remoteName}.lua`;
}

function compiledNameForSource(sourceName: string): string {
  return sourceName.replace(/\.lua$/i, ".lc");
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
    /^(stdin:\d+:|[\w./\\-]+\.lua:\d+:|PANIC:|lua:)/i.test(candidate),
  );
  return line ? `NodeMCU reported: ${line}` : null;
}

function extractMarkedPayload(output: string, beginMarker: string, endMarker: string): string | null {
  const end = output.lastIndexOf(endMarker);
  if (end < 0) return null;
  const begin = output.lastIndexOf(beginMarker, end);
  if (begin < 0) return null;
  return output.slice(begin + beginMarker.length, end);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation cancelled");
  }
}

function failure(error: unknown): Result {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}
