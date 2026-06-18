/**
 * Hardware e2e: proves the LFS (Lua Flash Store) feature end-to-end on a real
 * ESP8266, using the same production code paths the extension drives:
 *   1. `[build] lfs_size` -> BuildManager writes LUA_FLASH_STORE into
 *      user_config.h and reflashes; the firmware now has an LFS partition and
 *      (host C compiler present) a built `luac.cross`.
 *   2. `buildLfsImage` runs `luac.cross -f` to compile a Lua module into an LFS
 *      image.
 *   3. The image is uploaded to SPIFFS and loaded with `node.flashreload`.
 *   4. The module then resolves from flash (`node.LFS.list` / `require`), and is
 *      NOT present as a SPIFFS `.lc` file — confirming it came from the flash
 *      store, not the filesystem.
 *
 * Real hardware, so it only runs when NODEMCU_VSCODE_E2E_HARDWARE=1 (otherwise
 * skipped, keeping `npm test` green). Building luac.cross needs a host C
 * compiler; the firmware build self-downloads its xtensa toolchain on a fresh
 * build dir, so the first build can take several minutes.
 *
 * Required env:
 *   NODEMCU_VSCODE_E2E_HARDWARE=1
 * Optional env:
 *   NODEMCU_VSCODE_E2E_SERIAL_PORT     (default /dev/ttyUSB0 or COM7)
 *   NODEMCU_VSCODE_E2E_SERIAL_BAUD     (default 115200)
 *   NODEMCU_VSCODE_E2E_PYTHON          (default "python")
 *   NODEMCU_VSCODE_LFS_SIZE            (default 0x20000)
 *   NODEMCU_VSCODE_LFS_FIRMWARE_PATH   (reuse an existing firmware checkout
 *                                       instead of downloading the managed one)
 *   NODEMCU_VSCODE_STORAGE_ROOT        (managed-firmware cache root)
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SerialPort } from "serialport";
import { parseIni, defaultConfig, type NodemcuConfig } from "../../src/config/nodemcuIni";
import { BuildManager, type BuildContext } from "../../src/build/buildManager";
import { FlashManager } from "../../src/flash/flashManager";
import { ToolchainLocator } from "../../src/build/toolchain";
import { buildLfsImage } from "../../src/build/lfsBuilder";
import { ensureManagedFirmware } from "../../src/firmware/managedFirmware";
import { Shell } from "../../src/util/shell";
import { DirectSerialUploader } from "../../src/upload/directSerialUploader";
import { luacCrossPath, lfsImagePath } from "../../src/util/paths";

const PORT = process.env.NODEMCU_VSCODE_E2E_SERIAL_PORT || (process.platform === "win32" ? "COM7" : "/dev/ttyUSB0");
const BAUD = Number(process.env.NODEMCU_VSCODE_E2E_SERIAL_BAUD || "115200");
const PYTHON = process.env.NODEMCU_VSCODE_E2E_PYTHON || "python";
const LFS_SIZE = Number(process.env.NODEMCU_VSCODE_LFS_SIZE || "0x20000");
const STORAGE_ROOT = process.env.NODEMCU_VSCODE_STORAGE_ROOT || path.join(os.homedir(), ".nodemcu-vscode");
// A unique module name so we can prove it loaded from flash (not a stale SPIFFS file).
const MODULE = "e2elfsmod";

const enabled = process.env.NODEMCU_VSCODE_E2E_HARDWARE === "1";
const describe_ = enabled ? describe : describe.skip;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Open the REPL, send the given Lua lines (one chunk per line — device locals do
 * not persist across lines), and collect everything emitted for `windowMs`.
 * Returns the raw latin1 text. A bare reset can be requested first to clear any
 * armed handler / settle the prompt.
 */
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
    await sleep(8000); // boot + SPIFFS settle
  }
  for (const line of lines) {
    await write(line + "\r\n");
    await sleep(200);
  }
  await sleep(windowMs);
  await new Promise<void>((r) => (sp.isOpen ? sp.close(() => r()) : r()));
  await sleep(250);
  return out;
}

describe_("LFS (Lua Flash Store) hardware e2e", () => {
  let firmwarePath = "";
  let generator: BuildContext["generator"];
  let baseConfig: NodemcuConfig;
  const shell = new Shell();

  beforeAll(async () => {
    firmwarePath = process.env.NODEMCU_VSCODE_LFS_FIRMWARE_PATH
      || (await ensureManagedFirmware({ storageRoot: STORAGE_ROOT, onProgress: (m) => console.log(m) }));
    const toolchain = await new ToolchainLocator(shell).locate();
    generator = toolchain.generator;
    expect(toolchain.hostCC, "a host C compiler (cc/gcc) is required to build luac.cross for LFS").toBeTruthy();
    try {
      baseConfig = parseIni(fs.readFileSync(path.join(process.cwd(), "nodemcu.ini"), "utf-8"));
    } catch {
      baseConfig = defaultConfig();
    }
  }, 600_000);

  function configWithLfs(): NodemcuConfig {
    const cfg: NodemcuConfig = JSON.parse(JSON.stringify(baseConfig));
    cfg.nodemcu.port = PORT;
    // luac.cross and the firmware must be the same Lua flavour, or the device's
    // LFS loader rejects the image. The firmware fork must forward -DLUA to the
    // firmware ExternalProject for this to hold (see AGENTS §5.5); with that fix
    // the project-default lua53 works end to end.
    cfg.nodemcu.lua_version = (process.env.NODEMCU_VSCODE_LFS_LUA as "51" | "53") || "53";
    for (const m of ["wifi", "net", "node", "tmr", "uart", "file", "gpio"]) cfg.c_modules[m] = true;
    cfg.build.lfs_size = LFS_SIZE;
    return cfg;
  }

  it("builds firmware with an LFS partition + luac.cross and flashes it", async () => {
    const cfg = configWithLfs();
    const build = await new BuildManager(shell).build({
      firmwarePath,
      config: cfg,
      parallel: true,
      jobCount: Math.min(os.cpus().length, 8),
      verbose: false,
      generator,
      onLog: (s) => process.stdout.write(s),
      onStderr: (s) => process.stderr.write(s),
    });
    expect(build.success, `firmware build: ${build.summary}`).toBe(true);
    // The host tool must have been produced (host C compiler detected at configure).
    expect(fs.existsSync(luacCrossPath(firmwarePath)), `luac.cross missing at ${luacCrossPath(firmwarePath)}`).toBe(true);

    const flash = await new FlashManager(shell).flash({
      python: PYTHON,
      firmwarePath,
      config: cfg,
      port: PORT,
      onLog: (s) => process.stdout.write(s),
      onStderr: (s) => process.stderr.write(s),
    });
    expect(flash.success, `flash exit=${flash.exitCode}`).toBe(true);
    await sleep(10_000); // first boot formats SPIFFS

    // string.format, not concatenation: tostring(<number>) is unreliable on
    // some NodeMCU builds (returns "g") — see AGENTS §10.
    const out = await repl(
      [`local pt=node.getpartitiontable() print(string.format("LFS_PART=%d", pt and pt.lfs_size or -1))`],
      5000,
    );
    const m = /LFS_PART=(\d+)/.exec(out);
    process.stdout.write(`[lfs] partition probe: ${m ? m[1] : "(none)"} (expected ${LFS_SIZE})\n`);
    expect(m, `no LFS_PART line; output tail: ${out.slice(-300)}`).toBeTruthy();
    expect(Number(m![1])).toBe(LFS_SIZE);
  }, 1_800_000);

  it("compiles a module into an LFS image, flash-reloads it, and runs it from flash", async () => {
    // 1. A sample module with a unique marker so we can prove it executed from LFS.
    const srcLua = path.join(os.tmpdir(), `${MODULE}.lua`);
    fs.writeFileSync(srcLua, `local M = {} function M.ping() return "pong-from-lfs" end return M\n`, "utf-8");
    const outPath = lfsImagePath(firmwarePath);

    const img = await buildLfsImage(shell, {
      luacCross: luacCrossPath(firmwarePath),
      files: [srcLua],
      outPath,
      maxSize: LFS_SIZE,
      onLog: (s) => process.stdout.write(s),
      onStderr: (s) => process.stderr.write(s),
    });
    expect(img.success, `luac.cross image build: ${img.error}`).toBe(true);
    expect(fs.existsSync(outPath) && fs.statSync(outPath).size > 0, "lfs.img missing/empty").toBe(true);
    process.stdout.write(`[lfs] image built: ${outPath} (${fs.statSync(outPath).size} bytes)\n`);

    // 2. Make sure the module is NOT lingering in SPIFFS from a previous run, then
    //    upload the image. Retry the upload (a freshly flashed device may still be
    //    formatting SPIFFS).
    const uploader = new DirectSerialUploader();
    const uploaderOpts = { python: PYTHON, port: PORT, baud: BAUD, baudUpload: BAUD, compile: false };
    await repl([`file.remove("${MODULE}.lc")`, `file.remove("lfs.img")`], 1500);
    let uploaded = false;
    let lastErr = "";
    for (let attempt = 0; attempt < 5 && !uploaded; attempt++) {
      if (attempt > 0) await sleep(5000);
      const up = await uploader.upload(uploaderOpts, outPath, "lfs.img", () => {});
      uploaded = up.success;
      lastErr = up.error ?? lastErr;
    }
    expect(uploaded, `upload lfs.img failed: ${lastErr}`).toBe(true);

    // 3. Flash-reload the image (reboots the device into the new flash store).
    const reloadOut = await repl([`node.flashreload("lfs.img")`], 12_000);
    process.stdout.write(`[lfs] flashreload output tail: ${reloadOut.slice(-200).replace(/[^\x20-\x7e]/g, ".")}\n`);
    await sleep(4000);

    // 4. Verify the module resolves from LFS (canonical access is node.flashindex
    //    / node.LFS — NodeMCU's `require` does not always wire an LFS searcher),
    //    executes from flash, and is absent from SPIFFS.
    const verify = await repl(
      [
        `print("INFLASH="..type(node.flashindex and node.flashindex("${MODULE}")))`,
        `print("SPIFFS="..tostring(file.exists("${MODULE}.lc") or file.exists("${MODULE}.lua")))`,
        `local f=node.flashindex("${MODULE}") print("PING="..tostring(f and f().ping()))`,
        `local l=node.LFS.list() if l then for _,n in ipairs(l) do print("LFSMOD="..n) end end`,
      ],
      6000,
    );
    process.stdout.write(`[lfs] verify output:\n${verify.replace(/[^\x20-\x7e\n]/g, ".")}\n`);

    expect(/INFLASH=function/.test(verify), `module not in flash index; output: ${verify.slice(-400)}`).toBe(true);
    expect(new RegExp(`LFSMOD=${MODULE}`).test(verify), "module not listed by node.LFS.list()").toBe(true);
    expect(/SPIFFS=false/.test(verify), "module unexpectedly present as a SPIFFS file").toBe(true);
    expect(/PING=pong-from-lfs/.test(verify), `module did not run from LFS; output: ${verify.slice(-400)}`).toBe(true);

    fs.rmSync(srcLua, { force: true });
  }, 600_000);
});
