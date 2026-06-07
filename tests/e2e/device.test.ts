import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BuildManager } from "../../src/build/buildManager";
import { FlashManager } from "../../src/flash/flashManager";
import { ToolchainLocator } from "../../src/build/toolchain";
import { Shell } from "../../src/util/shell";
import { parseIni } from "../../src/config/nodemcuIni";
import { resolveFirmwarePath } from "../../src/util/paths";
import * as child_process from "node:child_process";

const PORT = "/dev/ttyUSB0";
const TEST_INI = "/tmp/opencode/nodemcu-test.ini";
const BACKUP_DIR = "/tmp/opencode/flash-backup";
const FIRMWARE_REPO = path.resolve(__dirname, "../../../nodemcu-firmware");

const hasFirmwareRepo = fs.existsSync(path.join(FIRMWARE_REPO, "CMakeLists.txt"));
const hasCMake = (() => {
  try {
    const r = child_process.spawnSync("cmake", ["--version"], { encoding: "utf-8" });
    return r.status === 0;
  } catch {
    return false;
  }
})();
const hasEsptool = (() => {
  try {
    const r = child_process.spawnSync("python3", ["-c", "import esptool; print(esptool.__version__)"], { encoding: "utf-8" });
    return r.status === 0 && /^\d+\.\d+/.test(r.stdout.trim());
  } catch {
    return false;
  }
})();
const hasDialoutGroup = (() => {
  try {
    const id = child_process.spawnSync("id", ["-g"], { encoding: "utf-8" });
    return id.stdout.trim() === "20";
  } catch {
    return false;
  }
})();

const describe_ = hasFirmwareRepo && hasCMake && hasEsptool && hasDialoutGroup ? describe : describe.skip;

console.log("device.test.ts preconditions:", {
  hasFirmwareRepo, hasCMake, hasEsptool, hasDialoutGroup,
});

describe_.skip("Pre-flight: real ESP8266 device is required", () => {});

describe_("E2E DEVICE: real ESP8266 build, flash, verify, upload", () => {
  let firmwarePath: string;
  let cfg: ReturnType<typeof parseIni>;
  let buildDir: string;
  let bin0: string;
  let bin1: string;
  let backupBin0: string;
  let backupBin1: string;

  beforeAll(async () => {
    if (fs.existsSync(BACKUP_DIR)) {
      fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    backupBin0 = path.join(BACKUP_DIR, "orig_0x00000.bin");
    backupBin1 = path.join(BACKUP_DIR, "orig_0x10000.bin");

    cfg = parseIni(fs.readFileSync(TEST_INI, "utf-8"));
    firmwarePath = resolveFirmwarePath(os.tmpdir(), cfg.nodemcu.firmware_path ?? "");
    buildDir = path.join(firmwarePath, "build");
    bin0 = path.join(firmwarePath, "bin", "0x00000.bin");
    bin1 = path.join(firmwarePath, "bin", "0x10000.bin");

    if (fs.existsSync(buildDir)) {
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
    if (fs.existsSync(bin0)) {
      fs.rmSync(bin0, { force: true });
    }
    if (fs.existsSync(bin1)) {
      fs.rmSync(bin1, { force: true });
    }
    const header = path.join(firmwarePath, "app", "include", "user_modules.h");
    if (fs.existsSync(header)) {
      fs.rmSync(header, { force: true });
    }
  }, 600_000);

  it("step 1: confirms device is a real ESP8266", async () => {
    const r = child_process.spawnSync("python3", ["-m", "esptool", "--port", PORT, "--baud", "115200", "chip-id"], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ESP8266/);
    expect(r.stdout).toMatch(/Chip ID:\s+0x/);
  });

  it("step 2: backs up existing firmware", async () => {
    const r = child_process.spawnSync("python3", [
      "-m", "esptool", "--port", PORT, "--baud", "115200",
      "read-flash", "0x0", "0x1000", backupBin0,
    ], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    const r2 = child_process.spawnSync("python3", [
      "-m", "esptool", "--port", PORT, "--baud", "115200",
      "read-flash", "0x10000", "0xA0000", backupBin1,
    ], { encoding: "utf-8" });
    expect(r2.status).toBe(0);
    expect(fs.existsSync(backupBin0)).toBe(true);
    expect(fs.existsSync(backupBin1)).toBe(true);
    const s0 = fs.statSync(backupBin0).size;
    const s1 = fs.statSync(backupBin1).size;
    expect(s0).toBe(0x1000);
    expect(s1).toBe(0xA0000);
  }, 120_000);

  it("step 3: builds firmware with 4M flash config and selected modules", async () => {
    const shell = new Shell();
    const toolchain = await new ToolchainLocator(shell).locate();
    const mgr = new BuildManager(shell);
    let buildLog = "";
    let buildErr = "";
    const result = await mgr.build({
      firmwarePath,
      config: cfg,
      parallel: true,
      jobCount: Math.min(os.cpus().length, 4),
      verbose: false,
      generator: toolchain.generator,
      onLog: (m) => { buildLog += m + "\n"; },
      onStderr: (m) => { buildErr += m + "\n"; },
    });
    if (!result.success) {
      console.log("=== BUILD LOG (last 4KB) ===\n" + buildLog.slice(-4096));
      console.log("=== BUILD ERR (last 4KB) ===\n" + buildErr.slice(-4096));
    }
    expect(result.success, `build failed: ${result.summary}`).toBe(true);
    expect(fs.existsSync(bin0)).toBe(true);
    expect(fs.existsSync(bin1)).toBe(true);
    const s0 = fs.statSync(bin0).size;
    const s1 = fs.statSync(bin1).size;
    expect(s0).toBeGreaterThan(1000);
    expect(s1).toBeGreaterThan(100_000);
  }, 600_000);

  it("step 4: flashes firmware to device via esptool (real write_flash)", async () => {
    const shell = new Shell();
    const mgr = new FlashManager(shell);
    let stderr = "";
    let stdout = "";
    const r = await mgr.flash({
      python: "python3",
      firmwarePath,
      config: cfg,
      port: PORT,
      onLog: (m) => { stdout += m + "\n"; },
      onStderr: (m) => { stderr += m + "\n"; },
    });
    if (!r.success) {
      console.log("=== FLASH STDOUT ===\n" + stdout);
      console.log("=== FLASH STDERR ===\n" + stderr);
      console.log("=== FLASH EXIT CODE ===\n" + r.exitCode);
    }
    expect(r.success, `flash failed; exit=${r.exitCode}`).toBe(true);
  }, 180_000);

  it("step 5: device responds to esptool after flash (not bricked)", async () => {
    const r = child_process.spawnSync("python3", ["-m", "esptool", "--port", PORT, "--baud", "115200", "chip-id"], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Chip ID:\s+0x/);
  }, 30_000);

  it("step 6: flash content matches (allowing esptool v5 header rewrite)", async () => {
    const size = 0x8000;
    const r = child_process.spawnSync("python3", [
      "-m", "esptool", "--port", PORT, "--baud", "115200",
      "read-flash", "0x0", String(size), "/tmp/opencode/post_flash.bin",
    ], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    const onDevice = fs.readFileSync("/tmp/opencode/post_flash.bin");
    const onDisk = fs.readFileSync(bin0);
    expect(onDevice[0]).toBe(0xe9);
    expect(onDevice[1]).toBe(0x03);
    expect(onDevice.length).toBe(size);
    expect(onDevice.subarray(16, onDisk.length).equals(onDisk.subarray(16))).toBe(true);
  }, 60_000);

  it("step 7: device exposes a Lua REPL (our firmware boots and runs)", async () => {
    const { execFileSync } = await import("node:child_process");
    await new Promise((r) => setTimeout(r, 2000));
    const out = execFileSync("python3", [
      "/tmp/opencode/repl_exec.py",
      PORT, "115200",
      "print(\"hi-from-host\")",
    ], { encoding: "utf-8" });
    console.log("=== REPL OUTPUT ===\n" + out);
    expect(out).toMatch(/(NodeMCU|hi-from-host|>) /);
  }, 30_000);

  it("step 8: compiles a Lua file to .lc with luac.cross", async () => {
    const luaSrc = "/tmp/opencode/test_pwm.lua";
    const lcOut = "/tmp/opencode/test_pwm.lc";
    const luaCross = path.join(firmwarePath, "build", "tools", "luac_cross", "luac.cross");
    expect(fs.existsSync(luaCross), `luac.cross not built at ${luaCross}`).toBe(true);
    const r = child_process.spawnSync(luaCross, ["-o", lcOut, luaSrc], { encoding: "utf-8" });
    expect(r.status, `luac.cross failed: ${r.stderr}`).toBe(0);
    expect(fs.existsSync(lcOut)).toBe(true);
    expect(fs.statSync(lcOut).size).toBeGreaterThan(0);
    const header = fs.readFileSync(lcOut, { encoding: "binary" });
    expect(header.startsWith("\x1bLua")).toBe(true);
  }, 30_000);

  it("step 9: incremental build that ADDS a new C module (coap) compiles the new code", async () => {
    const cfg2 = parseIni(fs.readFileSync(TEST_INI, "utf-8"));
    cfg2.c_modules.coap = true;
    const headerPath = path.join(firmwarePath, "app", "include", "user_modules.h");
    const before = fs.readFileSync(headerPath, "utf-8");
    expect(before).toMatch(/^\/\/#define LUA_USE_MODULES_COAP$/m);

    const shell = new Shell();
    const toolchain = await new ToolchainLocator(shell).locate();
    const mgr = new BuildManager(shell);
    let buildLog = "";
    let buildErr = "";
    const result = await mgr.build({
      firmwarePath,
      config: cfg2,
      parallel: true,
      jobCount: Math.min(os.cpus().length, 4),
      verbose: false,
      generator: toolchain.generator,
      onLog: (m) => { buildLog += m + "\n"; },
      onStderr: (m) => { buildErr += m + "\n"; },
    });
    if (!result.success) {
      console.log("=== STEP 9 BUILD LOG ===\n" + buildLog);
      console.log("=== STEP 9 BUILD ERR ===\n" + buildErr);
    }
    expect(result.success, `incremental build with new module failed: ${result.summary}`).toBe(true);
    expect(result.modulesChanged.added).toContain("coap");

    const after = fs.readFileSync(headerPath, "utf-8");
    expect(after).toMatch(/^#define LUA_USE_MODULES_COAP$/m);

    const objFiles = path.join(firmwarePath, "build", "firmware_build", "modules");
    const coapObj = path.join(objFiles, "CMakeFiles", "modules.dir", "coap.c.obj");
    expect(fs.existsSync(coapObj), `expected coap.c.o to be compiled at ${coapObj}`).toBe(true);
    const coapStat = fs.statSync(coapObj);
    expect(coapStat.mtimeMs, "coap.c.obj should be newer than user_modules.h after rebuild").toBeGreaterThanOrEqual(fs.statSync(headerPath).mtimeMs);
  }, 600_000);

  it("step 10: flash the firmware with the newly-added coap module", async () => {
    const shell = new Shell();
    const cfg3 = parseIni(fs.readFileSync(TEST_INI, "utf-8"));
    cfg3.c_modules.coap = true;
    const mgr = new FlashManager(shell);
    const r = await mgr.flash({
      python: "python3",
      firmwarePath,
      config: cfg3,
      port: PORT,
      onLog: () => {},
      onStderr: () => {},
    });
    expect(r.success, `flash with coap failed; exit=${r.exitCode}`).toBe(true);
  }, 180_000);

  it("step 11: runtime banner on device lists the newly-added coap module", async () => {
    const { execFileSync } = await import("node:child_process");
    await new Promise((r) => setTimeout(r, 2500));
    const out = execFileSync("python3", [
      "/tmp/opencode/repl_exec.py",
      PORT, "115200",
      "print(\"banner-check\")",
    ], { encoding: "utf-8" });
    console.log("=== BANNER OUTPUT ===\n" + out);
    expect(out).toMatch(/NodeMCU 3\.0\.0\.0/);
    const m = out.match(/modules:\s+([^\n]+)/);
    expect(m, "could not find 'modules:' line in banner").toBeTruthy();
    const mods = m![1].split(";").map((s) => s.trim()).filter(Boolean);
    expect(mods).toContain("coap");
    expect(mods).toContain("wifi");
    expect(mods).toContain("i2c");
    expect(mods).toEqual([...mods].sort());
  }, 30_000);

  it("step 12: the newly-added coap module is loadable and exposes its API on the REPL", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("python3", [
      "/tmp/opencode/repl_exec.py",
      PORT, "115200",
      "coap = require('coap'); print('type=' .. type(coap) .. ' has=' .. tostring(coap ~= nil))",
    ], { encoding: "utf-8" });
    console.log("=== REQUIRE COAP OUTPUT ===\n" + out);
    expect(out).toMatch(/type=table/);
  }, 30_000);
});
