import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BuildManager } from "../../src/build/buildManager";
import { FlashManager } from "../../src/flash/flashManager";
import { NodemcuTool } from "../../src/upload/nodemcuTool";
import { defaultConfig } from "../../src/config/nodemcuIni";
import { Shell, type ShellRunOptions, type ShellRunResult } from "../../src/util/shell";

class FakeShell extends Shell {
  calls: Array<{ command: string; args: string[] }> = [];
  responses: Array<Partial<ShellRunResult>> = [];
  nextResponse = (r: Partial<ShellRunResult>) => this.responses.push(r);

  async run(command: string, args: string[], opts: ShellRunOptions = {}): Promise<ShellRunResult> {
    this.calls.push({ command, args });
    const next = this.responses.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
    if (next.stdout) opts.onStdout?.(next.stdout);
    if (next.stderr) opts.onStderr?.(next.stderr);
    return { exitCode: 0, signal: null, stdout: "", stderr: "", ...next };
  }
  async which(binary: string): Promise<string | null> {
    if (binary === "python" || binary === "python3" || binary === "cmake" || binary === "ninja" || binary === "make") {
      return `/usr/bin/${binary}`;
    }
    return null;
  }
}

describe("BuildManager (integration, mocked shell)", () => {
  let tmp: string;
  let fwPath: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-vscode-int-"));
    fwPath = path.join(tmp, "fake-firmware");
    fs.mkdirSync(path.join(fwPath, "app", "include"), { recursive: true });
    fs.mkdirSync(path.join(fwPath, "cmake"), { recursive: true });
    fs.writeFileSync(path.join(fwPath, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.24)\nproject(fake)\n");
    fs.writeFileSync(path.join(fwPath, "app", "include", "user_modules.h"), "#define LUA_USE_MODULES_WIFI\n");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("runs cmake configure and build, returning success", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "Configuring\n" });
    shell.nextResponse({ exitCode: 0, stdout: "Building\n[100%] Built\n" });
    const mgr = new BuildManager(shell as unknown as Shell);
    const r = await mgr.build({
      firmwarePath: fwPath,
      config: defaultConfig(),
      parallel: true,
      jobCount: 4,
      verbose: false,
      generator: "Ninja",
      onLog: () => {},
      onStderr: () => {},
    });
    expect(r.success).toBe(true);
    expect(shell.calls).toHaveLength(2);
    expect(shell.calls[0].command).toBe("cmake");
    expect(shell.calls[0].args).toContain("-S");
    expect(shell.calls[0].args[shell.calls[0].args.indexOf("-S") + 1]).toBe(fwPath);
    expect(shell.calls[1].command).toBe("cmake");
    expect(shell.calls[1].args).toContain("--build");
  });

  it("skips configure when no modules changed (incremental build)", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "Building\n" });
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true };
    const mgr = new BuildManager(shell as unknown as Shell);
    const r = await mgr.build({
      firmwarePath: fwPath,
      config: cfg,
      parallel: true,
      jobCount: 4,
      verbose: false,
      generator: "Ninja",
      onLog: () => {},
      onStderr: () => {},
    });
    expect(r.success).toBe(true);
    expect(r.needsReconfigure).toBe(false);
    const cmakeCalls = shell.calls.filter((c) => c.command === "cmake");
    expect(cmakeCalls).toHaveLength(1);
    expect(cmakeCalls[0].args).toContain("--build");
  });

  it("returns failure with parsed problems on cmake error", async () => {
    const shell = new FakeShell();
    shell.nextResponse({
      exitCode: 1,
      stdout: "CMake Error at CMakeLists.txt:5 (message):\n  missing variable\n",
    });
    const mgr = new BuildManager(shell as unknown as Shell);
    const r = await mgr.build({
      firmwarePath: fwPath,
      config: defaultConfig(),
      parallel: true,
      jobCount: 4,
      verbose: false,
      generator: "Ninja",
      onLog: () => {},
      onStderr: () => {},
    });
    expect(r.success).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems[0].source).toBe("cmake");
  });

  it("regenerates user_modules.h from the config before building", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "Building\n" });
    const cfg = defaultConfig();
    cfg.c_modules = { mqtt: true, wifi: true, adc: false };
    const mgr = new BuildManager(shell as unknown as Shell);
    await mgr.build({
      firmwarePath: fwPath,
      config: cfg,
      parallel: true,
      jobCount: 4,
      verbose: false,
      generator: "Ninja",
      onLog: () => {},
      onStderr: () => {},
    });
    const header = fs.readFileSync(path.join(fwPath, "app", "include", "user_modules.h"), "utf-8");
    expect(header).toMatch(/^#define LUA_USE_MODULES_MQTT$/m);
    expect(header).toMatch(/^#define LUA_USE_MODULES_WIFI$/m);
    expect(header).toMatch(/^#define LUA_USE_MODULES_MQTT$/m);
    expect(header).toMatch(/^\/\/#define LUA_USE_MODULES_ADC$/m);
  });
});

describe("FlashManager (integration, mocked shell)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-vscode-flash-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("invokes python with esptool.py write_flash and the standard 0x00000/0x10000 offsets", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "Flashing...\n" });
    const mgr = new FlashManager(shell as unknown as Shell);
    const r = await mgr.flash({
      python: "python",
      firmwarePath: tmp,
      config: defaultConfig(),
      port: "/dev/ttyUSB0",
      onLog: () => {},
      onStderr: () => {},
    });
    expect(r.success).toBe(true);
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0].command).toBe("python");
    expect(shell.calls[0].args).toContain("write_flash");
    expect(shell.calls[0].args).toContain("/dev/ttyUSB0");
  });

  it("includes extra_files in the command", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "" });
    const cfg = defaultConfig();
    cfg.flash.extra_files = [{ path: "spiffs.bin", offset: "0x100000" }];
    const mgr = new FlashManager(shell as unknown as Shell);
    await mgr.flash({
      python: "python",
      firmwarePath: tmp,
      config: cfg,
      port: "/dev/ttyUSB0",
      onLog: () => {},
      onStderr: () => {},
    });
    expect(shell.calls[0].args).toContain("0x100000");
    expect(shell.calls[0].args).toContain("spiffs.bin");
  });
});

describe("NodemcuTool (integration, mocked shell)", () => {
  it("isInstalled returns true when import succeeds", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "ok\n" });
    const t = new NodemcuTool(shell as unknown as Shell);
    expect(await t.isInstalled("python")).toBe(true);
  });

  it("isInstalled returns false when import fails", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 1, stderr: "ModuleNotFoundError" });
    const t = new NodemcuTool(shell as unknown as Shell);
    expect(await t.isInstalled("python")).toBe(false);
  });

  it("upload invokes nodemcu-tool upload", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0 });
    const t = new NodemcuTool(shell as unknown as Shell);
    const r = await t.upload(
      { python: "python", port: "/dev/ttyUSB0", baud: 115200, baudUpload: 115200, compile: true },
      "/local/foo.lua",
      "foo.lua",
      () => {},
    );
    expect(r.success).toBe(true);
    expect(shell.calls[0].command).toBe("node");
    expect(shell.calls[0].args.join(" ")).toContain("nodemcu-tool.js");
    expect(shell.calls[0].args).toContain("upload");
    expect(shell.calls[0].args).toContain("--remotename");
    expect(shell.calls[0].args).toContain("foo.lua");
    expect(shell.calls[0].args).toContain("/local/foo.lua");
  });

  it("download invokes nodemcu-tool download", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0 });
    const t = new NodemcuTool(shell as unknown as Shell);
    const r = await t.download(
      { python: "python", port: "/dev/ttyUSB0", baud: 115200, baudUpload: 115200, compile: false },
      "init.lua",
      "/local/init.lua",
      () => {},
    );
    expect(r.success).toBe(true);
    expect(shell.calls[0].command).toBe("node");
    expect(shell.calls[0].args).toContain("download");
    expect(shell.calls[0].args).toContain("init.lua");
  });

  it("remove invokes nodemcu-tool remove", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0 });
    const t = new NodemcuTool(shell as unknown as Shell);
    const r = await t.remove(
      { python: "python", port: "/dev/ttyUSB0", baud: 115200, baudUpload: 115200, compile: false },
      "init.lua",
      () => {},
    );
    expect(r.success).toBe(true);
    expect(shell.calls[0].command).toBe("node");
    expect(shell.calls[0].args).toContain("remove");
  });

  it("listFiles parses nodemcu-tool fsinfo JSON output", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: JSON.stringify({ files: [{ name: "init.lua", size: 234 }, { name: "foo.lua", size: 100 }] }) });
    const t = new NodemcuTool(shell as unknown as Shell);
    const files = await t.listFiles(
      { python: "python", port: "/dev/ttyUSB0", baud: 115200, baudUpload: 115200, compile: false },
      () => {},
    );
    expect(shell.calls[0].command).toBe("node");
    expect(shell.calls[0].args).toContain("fsinfo");
    expect(shell.calls[0].args).toContain("--json");
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe("init.lua");
    expect(files[0].size).toBe(234);
    expect(files[1].size).toBe(100);
  });
});
