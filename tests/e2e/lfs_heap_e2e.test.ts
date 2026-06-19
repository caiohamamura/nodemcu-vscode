/**
 * Hardware e2e: quantifies the whole point of LFS — RAM savings — by loading the
 * exact same Lua module two ways on a real ESP8266 and comparing `node.heap()`:
 *
 *   1. From the flash store (`node.flashindex`): the bytecode prototypes stay in
 *      flash; only the returned module table + closures live in RAM.
 *   2. From SPIFFS (`dofile` of a `.lc`): the loader copies every prototype,
 *      constant, and string into the ~40 KB Lua heap.
 *
 * The module is intentionally fat (hundreds of functions + string constants) so
 * the difference is unmistakable. We assert that the heap free with the module
 * active is higher for LFS than for SPIFFS, and that the marginal RAM cost of
 * the module is much smaller from flash.
 *
 * Requires LFS-capable firmware already flashed (run lfs_e2e first, or any build
 * with `[build] lfs_size > 0`). Real hardware, so gated on
 * NODEMCU_VSCODE_E2E_HARDWARE=1 (skipped otherwise, keeping `npm test` green).
 *
 * Required env:  NODEMCU_VSCODE_E2E_HARDWARE=1
 * Optional env:  NODEMCU_VSCODE_E2E_SERIAL_PORT (default /dev/ttyUSB0 or COM7)
 *                NODEMCU_VSCODE_E2E_SERIAL_BAUD  (default 115200)
 *                NODEMCU_VSCODE_E2E_PYTHON       (default python/python3/py)
 *                NODEMCU_VSCODE_LUAC_CROSS       (path to luac.cross; required if
 *                                                 no firmware checkout is given)
 *                NODEMCU_VSCODE_LFS_FIRMWARE_PATH (firmware checkout to locate
 *                                                  the built luac.cross)
 *                NODEMCU_VSCODE_LFS_SIZE         (default 0x20000)
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as child_process from "node:child_process";
import { SerialPort } from "serialport";
import { buildLfsImage } from "../../src/build/lfsBuilder";
import { DirectSerialUploader } from "../../src/upload/directSerialUploader";
import { Shell } from "../../src/util/shell";
import { luacCrossPath } from "../../src/util/paths";

const PORT = process.env.NODEMCU_VSCODE_E2E_SERIAL_PORT || (process.platform === "win32" ? "COM7" : "/dev/ttyUSB0");
const BAUD = Number(process.env.NODEMCU_VSCODE_E2E_SERIAL_BAUD || "115200");
const LFS_SIZE = Number(process.env.NODEMCU_VSCODE_LFS_SIZE || "0x20000");
const MODULE = "fatmod";

function resolvePython(): string {
  if (process.env.NODEMCU_VSCODE_E2E_PYTHON) return process.env.NODEMCU_VSCODE_E2E_PYTHON;
  for (const candidate of ["python", "python3", "py"]) {
    const r = child_process.spawnSync(process.platform === "win32" ? "where" : "which", [candidate], { encoding: "utf-8" });
    if (r.status === 0 && (r.stdout || "").trim()) return candidate;
  }
  return "python";
}
const PYTHON = resolvePython();

function resolveLuacCross(): string {
  if (process.env.NODEMCU_VSCODE_LUAC_CROSS) return process.env.NODEMCU_VSCODE_LUAC_CROSS;
  if (process.env.NODEMCU_VSCODE_LFS_FIRMWARE_PATH) return luacCrossPath(process.env.NODEMCU_VSCODE_LFS_FIRMWARE_PATH);
  return "";
}

const enabled = process.env.NODEMCU_VSCODE_E2E_HARDWARE === "1";
const describe_ = enabled ? describe : describe.skip;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Open the REPL, optionally restart for a clean heap, send lines, collect output. */
async function repl(lines: string[], windowMs: number, opts: { reset?: boolean } = {}): Promise<string> {
  let out = "";
  const sp = await new Promise<SerialPort>((resolve, reject) => {
    const p = new SerialPort({ path: PORT, baudRate: BAUD }, (err) => (err ? reject(err) : resolve(p)));
  });
  sp.on("data", (c: Buffer) => (out += c.toString("latin1")));
  const write = (s: string) => new Promise<void>((r) => sp.write(s, () => sp.drain(() => r())));
  await write("\r\n");
  await sleep(300);
  if (opts.reset) {
    await write("node.restart()\r\n");
    await sleep(8000);
    await write("\r\n");
    await sleep(300);
  }
  for (const line of lines) {
    await write(line + "\r\n");
    await sleep(250);
  }
  await sleep(windowMs);
  await new Promise<void>((r) => (sp.isOpen ? sp.close(() => r()) : r()));
  await sleep(250);
  return out;
}

/** Generate a deliberately heap-heavy module: many closures + string constants. */
function fatModuleSource(): string {
  const lines: string[] = ["local M = {}"];
  // Sized so the SPIFFS load (all prototypes copied into the ~40 KB Lua heap)
  // still fits, while leaving a clear LFS-vs-SPIFFS gap. 240+ funcs OOM the
  // on-device loader, which proves the point but breaks the measurement.
  for (let i = 0; i < 70; i++) {
    lines.push(`function M.f${i}(x) return x + ${i} .. "_const_string_payload_number_${i}_padding_xxxxxxxxxxxxxxxx" end`);
  }
  lines.push("return M");
  return lines.join("\n") + "\n";
}

describe_("LFS vs SPIFFS heap usage (hardware)", () => {
  let luacCross = "";
  const shell = new Shell();
  const srcLua = path.join(os.tmpdir(), `${MODULE}.lua`);
  const lcPath = path.join(os.tmpdir(), `${MODULE}.lc`);
  const imgPath = path.join(os.tmpdir(), `${MODULE}-lfs.img`);

  beforeAll(async () => {
    luacCross = resolveLuacCross();
    expect(luacCross && fs.existsSync(luacCross), `luac.cross not found (${luacCross}); set NODEMCU_VSCODE_LUAC_CROSS`).toBe(true);
    fs.writeFileSync(srcLua, fatModuleSource(), "utf-8");

    // Plain bytecode for the SPIFFS path...
    const lc = await shell.run(luacCross, ["-o", lcPath, srcLua], {});
    expect(lc.exitCode, `luac.cross -o failed: ${lc.stderr}`).toBe(0);
    // ...and a flash image for the LFS path.
    const img = await buildLfsImage(shell, { luacCross, files: [srcLua], outPath: imgPath, maxSize: LFS_SIZE });
    expect(img.success, `LFS image build: ${img.error}`).toBe(true);
  }, 120_000);

  const parseHeap = (re: RegExp, text: string): number => {
    const m = re.exec(text);
    expect(m, `marker not found; output tail: ${text.slice(-300)}`).toBeTruthy();
    return Number(m![1]);
  };

  it("loads the same module from LFS with far less RAM than from SPIFFS", async () => {
    const uploader = new DirectSerialUploader();
    const upOpts = { python: PYTHON, port: PORT, baud: BAUD, baudUpload: BAUD, compile: false };

    // ---- SPIFFS path: upload .lc, load it into the heap, measure cost. ----
    await repl([`file.remove("${MODULE}.lc")`], 1500, { reset: true });
    let upOk = false, upErr = "";
    for (let a = 0; a < 5 && !upOk; a++) {
      if (a > 0) await sleep(4000);
      const r = await uploader.upload(upOpts, lcPath, `${MODULE}.lc`, () => {});
      upOk = r.success; upErr = r.error ?? upErr;
    }
    expect(upOk, `upload ${MODULE}.lc failed: ${upErr}`).toBe(true);

    const spiffsOut = await repl(
      [
        `collectgarbage("collect") print(string.format("SP_BEFORE=%d", node.heap()))`,
        `_G.MOD = dofile("${MODULE}.lc")`,
        `collectgarbage("collect") print(string.format("SP_AFTER=%d", node.heap()))`,
        `print("SP_OK="..type(_G.MOD and _G.MOD.f0))`,
      ],
      4000,
      { reset: true },
    );
    const spBefore = parseHeap(/SP_BEFORE=(\d+)/, spiffsOut);
    const spAfter = parseHeap(/SP_AFTER=(\d+)/, spiffsOut);
    expect(/SP_OK=function/.test(spiffsOut), `SPIFFS module didn't load: ${spiffsOut.slice(-300)}`).toBe(true);
    const spiffsCost = spBefore - spAfter;

    // ---- LFS path: flashreload the image, load from flash, measure cost. ----
    await repl([`file.remove("lfs.img")`], 1500);
    upOk = false;
    for (let a = 0; a < 5 && !upOk; a++) {
      if (a > 0) await sleep(4000);
      const r = await uploader.upload(upOpts, imgPath, "lfs.img", () => {});
      upOk = r.success; upErr = r.error ?? upErr;
    }
    expect(upOk, `upload lfs.img failed: ${upErr}`).toBe(true);
    await repl([`node.flashreload("lfs.img")`], 10_000);
    await sleep(4000);
    // Remove the SPIFFS copy so the measurement reflects flash-only residency.
    const lfsOut = await repl(
      [
        `file.remove("${MODULE}.lc")`,
        `collectgarbage("collect") print(string.format("LFS_BEFORE=%d", node.heap()))`,
        `_G.MOD = node.flashindex("${MODULE}")()`,
        `collectgarbage("collect") print(string.format("LFS_AFTER=%d", node.heap()))`,
        `print("LFS_OK="..type(_G.MOD and _G.MOD.f0))`,
        `print("LFS_IN="..type(node.flashindex("${MODULE}")))`,
      ],
      5000,
      { reset: true },
    );
    const lfsBefore = parseHeap(/LFS_BEFORE=(\d+)/, lfsOut);
    const lfsAfter = parseHeap(/LFS_AFTER=(\d+)/, lfsOut);
    expect(/LFS_OK=function/.test(lfsOut), `LFS module didn't load: ${lfsOut.slice(-300)}`).toBe(true);
    expect(/LFS_IN=function/.test(lfsOut), "module not resident in flash index").toBe(true);
    const lfsCost = lfsBefore - lfsAfter;

    process.stdout.write(
      `\n[heap] module: ${MODULE} (${fs.statSync(srcLua).size} B source, ${fs.statSync(lcPath).size} B bytecode)\n` +
        `[heap] SPIFFS: free ${spBefore} -> ${spAfter}  (module RAM cost ${spiffsCost} B)\n` +
        `[heap] LFS:    free ${lfsBefore} -> ${lfsAfter}  (module RAM cost ${lfsCost} B)\n` +
        `[heap] LFS saves ${spiffsCost - lfsCost} B of RAM vs SPIFFS for this module\n` +
        `[heap] free heap with module active: LFS ${lfsAfter} vs SPIFFS ${spAfter} (+${lfsAfter - spAfter} B)\n`,
    );

    // The whole point of LFS: the module costs dramatically less RAM from flash,
    // and more heap remains free with it active.
    expect(lfsCost).toBeLessThan(spiffsCost);
    expect(lfsAfter).toBeGreaterThan(spAfter);

    fs.rmSync(srcLua, { force: true });
    fs.rmSync(lcPath, { force: true });
    fs.rmSync(imgPath, { force: true });
  }, 300_000);
});
