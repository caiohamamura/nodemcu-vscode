import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BuildManager } from "../../src/build/buildManager";
import { ToolchainLocator, esptoolFlashCommand } from "../../src/build/toolchain";
import { Shell } from "../../src/util/shell";
import { defaultConfig } from "../../src/config/nodemcuIni";
import { formatCommand } from "../../src/util/shell";

const FIRMWARE_REPO = path.resolve(__dirname, "../../../nodemcu-firmware");

const hasFirmwareRepo = fs.existsSync(path.join(FIRMWARE_REPO, "CMakeLists.txt"));
const hasCMake = (() => {
  try {
    const r = require("node:child_process").spawnSync("cmake", ["--version"], { encoding: "utf-8" });
    return r.status === 0;
  } catch {
    return false;
  }
})();
const hasPython = (() => {
  for (const c of ["python3", "python"]) {
    try {
      const r = require("node:child_process").spawnSync(c, ["--version"], { encoding: "utf-8" });
      if (r.status === 0) return c;
    } catch {
      // try next
    }
  }
  return null;
})();

const e2eDescribe = hasFirmwareRepo && hasCMake && hasPython ? describe : describe.skip;

e2eDescribe("E2E: real build against the nodemcu-firmware repo", () => {
  let logs: string[] = [];
  let errs: string[] = [];

  beforeAll(() => {
    logs = [];
    errs = [];
    const buildDir = path.join(FIRMWARE_REPO, "build");
    if (fs.existsSync(buildDir)) {
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
    const bin0Path = path.join(FIRMWARE_REPO, "bin", "0x00000.bin");
    const bin1Path = path.join(FIRMWARE_REPO, "bin", "0x10000.bin");
    if (fs.existsSync(bin0Path)) {
      fs.rmSync(bin0Path, { force: true });
    }
    if (fs.existsSync(bin1Path)) {
      fs.rmSync(bin1Path, { force: true });
    }
    const header = path.join(FIRMWARE_REPO, "app", "include", "user_modules.h");
    if (fs.existsSync(header)) {
      fs.rmSync(header, { force: true });
    }
  });

  it("configures and builds the firmware, producing 0x00000.bin and 0x10000.bin", async () => {
    const shell = new Shell();
    const toolchain = await new ToolchainLocator(shell).locate();
    expect(["Ninja", "Unix Makefiles"]).toContain(toolchain.generator);

    const fwPath = FIRMWARE_REPO;
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true, node: true, file: true, gpio: true, tmr: true, net: true, uart: true };

    const mgr = new BuildManager(shell);
    const result = await mgr.build({
      firmwarePath: fwPath,
      config: cfg,
      parallel: true,
      jobCount: Math.min(os.cpus().length, 4),
      verbose: false,
      generator: toolchain.generator,
      onLog: (s) => logs.push(s),
      onStderr: (s) => errs.push(s),
    });

    expect(result.success, `build failed: ${result.summary}\nlogs:\n${logs.join("")}\nstderr:\n${errs.join("")}`).toBe(true);
    expect(result.needsReconfigure).toBe(true);
    expect(result.modulesChanged.added).toEqual(expect.arrayContaining(["wifi", "node", "file", "gpio", "tmr", "net", "uart"]));

    const bin0 = path.join(fwPath, "bin", "0x00000.bin");
    const bin1 = path.join(fwPath, "bin", "0x10000.bin");
    expect(fs.existsSync(bin0), `expected ${bin0} to exist`).toBe(true);
    expect(fs.existsSync(bin1), `expected ${bin1} to exist`).toBe(true);

    const size0 = fs.statSync(bin0).size;
    const size1 = fs.statSync(bin1).size;
    expect(size0).toBeGreaterThan(1000);
    expect(size1).toBeGreaterThan(1000);
  }, 900_000);

  it("rebuild is incremental (no reconfigure when modules unchanged)", async () => {
    const shell = new Shell();
    const toolchain = await new ToolchainLocator(shell).locate();
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true, node: true, file: true, gpio: true, tmr: true, net: true, uart: true };
    const mgr = new BuildManager(shell);
    const t0 = Date.now();
    const result = await mgr.build({
      firmwarePath: FIRMWARE_REPO,
      config: cfg,
      parallel: true,
      jobCount: Math.min(os.cpus().length, 4),
      verbose: false,
      generator: toolchain.generator,
      onLog: () => { },
      onStderr: () => { },
    });
    expect(result.success).toBe(true);
    expect(result.needsReconfigure).toBe(false);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(300_000);
  }, 600_000);

  it("adding a new C module regenerates the .bin files (elf2image re-runs)", async () => {
    const shell = new Shell();
    const toolchain = await new ToolchainLocator(shell).locate();
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true, node: true, file: true, gpio: true, tmr: true, net: true, uart: true };
    const mgr = new BuildManager(shell);
    const result = await mgr.build({
      firmwarePath: FIRMWARE_REPO,
      config: cfg,
      parallel: true,
      jobCount: Math.min(os.cpus().length, 4),
      verbose: false,
      generator: toolchain.generator,
      onLog: () => { },
      onStderr: () => { },
    });
    expect(result.success, `build failed: ${result.summary}`).toBe(true);

    const bin0Before = fs.statSync(path.join(FIRMWARE_REPO, "bin", "0x00000.bin")).mtimeMs;
    const elfBefore = fs.statSync(path.join(FIRMWARE_REPO, "build", "firmware_build", "app.elf")).mtimeMs;
    expect(bin0Before).toBeGreaterThanOrEqual(elfBefore - 1);

    cfg.c_modules.coap = true;
    const result2 = await mgr.build({
      firmwarePath: FIRMWARE_REPO,
      config: cfg,
      parallel: true,
      jobCount: Math.min(os.cpus().length, 4),
      verbose: false,
      generator: toolchain.generator,
      onLog: () => { },
      onStderr: () => { },
    });
    expect(result2.success, `incremental build with new module failed: ${result2.summary}`).toBe(true);
    expect(result2.modulesChanged.added).toContain("coap");

    const bin0After = fs.statSync(path.join(FIRMWARE_REPO, "bin", "0x00000.bin")).mtimeMs;
    const elfAfter = fs.statSync(path.join(FIRMWARE_REPO, "build", "firmware_build", "app.elf")).mtimeMs;
    expect(elfAfter).toBeGreaterThanOrEqual(elfBefore);
    expect(bin0After, "0x00000.bin was not regenerated when app.elf changed").toBeGreaterThanOrEqual(elfAfter - 1);

    const bin1Size = fs.statSync(path.join(FIRMWARE_REPO, "bin", "0x10000.bin")).size;
    expect(bin1Size).toBeGreaterThan(100_000);
  }, 600_000);
});

describe("E2E: flash command construction", () => {
  it("builds a valid esptool write_flash command for the produced binaries", () => {
    const cmd = esptoolFlashCommand({
      python: hasPython ?? "python3",
      esptool: path.join(FIRMWARE_REPO, "tools", "toolchains", "esptool.py"),
      port: "/dev/ttyUSB0",
      baud: 115200,
      flashMode: "dio",
      flashFreq: "80m",
      flashSize: "4MB",
      bin0: path.join(FIRMWARE_REPO, "bin", "0x00000.bin"),
      bin1: path.join(FIRMWARE_REPO, "bin", "0x10000.bin"),
      extraFiles: [],
    });
    expect(cmd.command).toBeTruthy();
    expect(cmd.args).toContain("write_flash");
    expect(cmd.args).toContain("0x00000");
    expect(cmd.args).toContain("0x10000");
    expect(formatCommand(cmd)).toMatch(/write_flash/);
  });
});
