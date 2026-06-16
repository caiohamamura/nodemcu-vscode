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
const TEMP_REMOTE_NAME = ".__nodemcu_upload_tmp";
// Raw-stream tuning. The device captures the byte stream straight into SPIFFS
// via a uart.on("data") handler (run_input=0, so bytes are written verbatim and
// never interpreted), instead of the old hex-per-REPL-command loop.
//
// Two hard constraints, both learned from the physical device:
//   1. The NodeMCU REPL input line buffer is ~256 bytes; a longer command is
//      silently truncated and fails to parse. Every command we send stays well
//      under that — the handler is registered in small pieces.
//   2. Blasting the whole file at once overflows the UART RX buffer (the Lua
//      data callback cannot drain + file.write fast enough at 115200), so bytes
//      are lost. We therefore send fixed-size windows and wait for the device
//      to ACK each one — flow control that bounds in-flight bytes to one window.
const STREAM_WINDOW = 256;
const STREAM_ACK_TIMEOUT_MS = 15_000;
// Generous: a large file plus SPIFFS write/GC stalls can take a while.
const STREAM_DONE_TIMEOUT_MS = 60_000;
// Device-side helper: hex-encode a byte string. Defined as its own short REPL
// command (the whole line must stay under NodeMCU's ~256-char input buffer).
const HEX_OF_STRING_DEF =
  `_G.__h=function(s) local o="" for i=1,#s do o=o..string.format("%02x",string.byte(s,i)) end return o end`;

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
        await this.streamToTempFile(cursor, Buffer.from(content), options.signal);

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

  /**
   * Stream `content` straight into the device's temp SPIFFS file.
   *
   * Instead of issuing a REPL command per chunk (the old hex loop, which paid a
   * round-trip + prompt wait for every ~100 bytes), we arm a uart.on("data")
   * handler on the device that writes received bytes directly to the open file,
   * then send the raw bytes. `run_input` is 0 so the bytes are written verbatim
   * and never echoed or interpreted — which makes the transfer binary-safe (the
   * payload may contain any byte, including what would look like an end marker)
   * and roughly halves the bytes on the wire versus hex.
   *
   * Flow control: the file is sent in fixed-size windows. The handler ACKs each
   * completed window so we never have more than one window in flight — without
   * this the RX buffer overflows and bytes are silently dropped. Termination is
   * by exact byte count (not an in-band marker), so it is immune to a marker
   * being split across UART callbacks. When the last byte lands the handler
   * unregisters itself (handing control back to the REPL) and prints a done
   * marker we wait for.
   *
   * Every command stays well under the ~256-byte REPL input buffer; a longer
   * line is silently truncated by NodeMCU and would fail to parse.
   */
  private async streamToTempFile(cursor: SerialCursor, content: Buffer, signal?: AbortSignal): Promise<void> {
    await this.execute(cursor, `file.remove(${luaString(TEMP_REMOTE_NAME)})`, signal);

    if (content.length === 0) {
      // No bytes to stream — the handler would never fire. Just create + close.
      await this.execute(cursor, `assert(file.open(${luaString(TEMP_REMOTE_NAME)},"w+")) file.close()`, signal);
      return;
    }

    // Short unique id keeps the register command well under the REPL line limit
    // while still distinguishing this transfer's markers from any stale output.
    const id = randomUUID().replace(/-/g, "").slice(0, 8);
    const ackMarker = `~uA${id}~`;
    const doneMarker = `~uZ${id}~`;
    // Registered in pieces to stay under the REPL input-line limit. Globals hold
    // the transfer state (uL=total, uW=window, un=received, ua=last ACKed).
    await this.execute(cursor, `_G.uL=${content.length} _G.uW=${STREAM_WINDOW} _G.un=0 _G.ua=0`, signal);
    await this.execute(cursor, `assert(file.open(${luaString(TEMP_REMOTE_NAME)},"w+"))`, signal);
    const register =
      `uart.on("data",0,function(d) file.write(d) un=un+#d ` +
      `if un>=ua+uW then ua=ua+uW uart.write(0,${luaString(ackMarker)}) end ` +
      `if un>=uL then file.close() uart.on("data") uart.write(0,${luaString(doneMarker)}) end end,0)`;
    // After this returns the handler is armed; every subsequent byte we send is
    // captured by it rather than interpreted by the REPL.
    await this.execute(cursor, register, signal);

    for (let offset = 0; offset < content.length; offset += STREAM_WINDOW) {
      throwIfAborted(signal);
      const end = Math.min(offset + STREAM_WINDOW, content.length);
      await this.session.write(content.subarray(offset, end), { signal });
      // The final window is confirmed by the done marker, not an ACK.
      if (end < content.length) {
        await cursor.waitFor(ackMarker, { timeoutMs: STREAM_ACK_TIMEOUT_MS, signal });
      }
    }

    // Device confirms every byte is written and the UART is back under REPL
    // control. Subsequent execute() calls drive the REPL normally again.
    await cursor.waitFor(doneMarker, { timeoutMs: STREAM_DONE_TIMEOUT_MS, signal });
  }

  async download(remoteName: string): Promise<{ success: boolean; content?: Buffer; error?: string }> {
    try {
      validateRemoteName(remoteName);
      const content = await this.session.runExclusive(`Download ${remoteName}`, async (cursor) => {
        await this.ensurePrompt(cursor);
        // Defined in pieces so each REPL line stays under the ~256-char input
        // buffer (a longer line is silently truncated by NodeMCU). `string.format`
        // is used rather than `tostring`, whose number path is broken on some
        // firmware builds (returns "g").
        await this.execute(cursor, HEX_OF_STRING_DEF);
        // RAM-safe: stream the hex straight to the UART in 64-byte chunks rather
        // than building the whole hex string in the device's ~40 KB heap (which
        // OOMs for files over ~2 KB). The read loop is synchronous, so NodeMCU's
        // cooperative scheduler cannot interleave background output into it.
        await this.execute(
          cursor,
          `_G.__dump=function(f) if not file.open(f,"r") then uart.write(0,"ERR") return end while true do local c=file.read(64) if not c then break end uart.write(0,__h(c)) end file.close() end`,
        );
        const { begin, end, id } = createMarkers();
        const output = await this.execute(
          cursor,
          `uart.write(0,${luaString(begin)}) __dump(${luaString(remoteName)}) uart.write(0,${luaString(end)})`,
          undefined,
          STREAM_DONE_TIMEOUT_MS,
        );
        const payload = extractMarkedPayload(output, begin, end);
        if (payload === null || payload.startsWith("ERR")) {
          throw new Error(`Unable to read remote file: ${remoteName} (${id})`);
        }
        return Buffer.from(payload.replace(/[^0-9a-fA-F]/g, ""), "hex");
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
        await this.execute(cursor, HEX_OF_STRING_DEF);
        const { begin, end, id } = createMarkers();
        // `string.format("%d",size)` not `tostring(size)`: the latter's number
        // path is broken on some firmware builds (returns "g").
        const output = await this.execute(
          cursor,
          [
            `uart.write(0,${luaString(begin)});`,
            `for name,size in pairs(file.list()) do`,
            `print(__h(name)..string.char(9)..string.format("%d",size));`,
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
