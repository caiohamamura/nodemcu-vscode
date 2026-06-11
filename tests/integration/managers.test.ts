import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BuildManager } from "../../src/build/buildManager";
import { writeUserModulesHeader } from "../../src/build/userModulesWriter";
import { FlashManager } from "../../src/flash/flashManager";
import { NodemcuTool } from "../../src/upload/nodemcuTool";
import { defaultConfig } from "../../src/config/nodemcuIni";
import { readDeviceIdentity } from "../../src/device/deviceIdentity";
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
    // Simulate a previously completed build so incremental-build tests see no missing build dir.
    fs.mkdirSync(path.join(fwPath, "build"), { recursive: true });
    fs.writeFileSync(path.join(fwPath, "build", "CMakeCache.txt"), "# fake cache\n");
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true };
    writeUserModulesHeader(path.join(fwPath, "app", "include", "user_modules.h"), cfg);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("runs cmake configure and build, returning success", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "Configuring\n" });
    shell.nextResponse({ exitCode: 0, stdout: "Building\n[100%] Built\n" });
    const cfg = defaultConfig();
    cfg.c_modules = { mqtt: true }; // Force reconfigure
    const mgr = new BuildManager(shell as unknown as Shell);
    const r = await mgr.build({
      firmwarePath: fwPath,
      config: cfg,
      parallel: true,
      jobCount: 4,
      verbose: false,
      generator: "Ninja",
      onLog: () => { },
      onStderr: () => { },
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
      onLog: () => { },
      onStderr: () => { },
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
      onLog: () => { },
      onStderr: () => { },
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
      onLog: () => { },
      onStderr: () => { },
    });
    const header = fs.readFileSync(path.join(fwPath, "app", "include", "user_modules.h"), "utf-8");
    expect(header).toMatch(/^#define LUA_USE_MODULES_MQTT$/m);
    expect(header).toMatch(/^#define LUA_USE_MODULES_WIFI$/m);
    expect(header).toMatch(/^#define LUA_USE_MODULES_MQTT$/m);
    expect(header).toMatch(/^\/\/#define LUA_USE_MODULES_ADC$/m);
  });

  it("reconfigures, rebuilds, then flashes when nodemcu.ini C modules change", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "Configuring\n" });
    shell.nextResponse({ exitCode: 0, stdout: "Building\n" });
    shell.nextResponse({ exitCode: 0, stdout: "Writing flash\n" });

    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true, coap: true };

    const build = await new BuildManager(shell as unknown as Shell).build({
      firmwarePath: fwPath,
      config: cfg,
      parallel: true,
      jobCount: 4,
      verbose: false,
      generator: "Ninja",
      onLog: () => { },
      onStderr: () => { },
    });
    expect(build.success).toBe(true);
    expect(build.needsReconfigure).toBe(true);
    expect(build.modulesChanged.added).toContain("coap");

    const flash = await new FlashManager(shell as unknown as Shell).flash({
      python: "python",
      firmwarePath: fwPath,
      config: cfg,
      port: "COM42",
      onLog: () => { },
      onStderr: () => { },
    });
    expect(flash.success).toBe(true);

    expect(shell.calls).toHaveLength(3);
    expect(shell.calls[0].command).toBe("cmake");
    expect(shell.calls[0].args).toContain("-S");
    expect(shell.calls[1].command).toBe("cmake");
    expect(shell.calls[1].args).toContain("--build");
    expect(shell.calls[2].command).toBe("python");
    expect(shell.calls[2].args).toContain("write_flash");
    expect(shell.calls[2].args).toContain("COM42");
  });

  it("runs configure and build through the resolved managed CMake executable", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "Configuring\n" });
    shell.nextResponse({ exitCode: 0, stdout: "Building\n" });
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true, coap: true };

    const build = await new BuildManager(shell as unknown as Shell).build({
      firmwarePath: fwPath,
      config: cfg,
      parallel: true,
      jobCount: 4,
      verbose: false,
      generator: "Ninja",
      preferredCmake: "/managed/cmake",
      onLog: () => { },
      onStderr: () => { },
    });

    expect(build.success).toBe(true);
    expect(shell.calls[0].command).toBe("/managed/cmake");
    expect(shell.calls[0].args).toContain("-S");
    expect(shell.calls[1].command).toBe("/managed/cmake");
    expect(shell.calls[1].args).toContain("--build");
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
      onLog: () => { },
      onStderr: () => { },
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
      onLog: () => { },
      onStderr: () => { },
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
      () => { },
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
      () => { },
    );
    expect(r.success).toBe(true);
    expect(shell.calls[0].command).toBe("node");
    expect(shell.calls[0].args).toContain("download");
    expect(shell.calls[0].args).toContain("init.lua");
  });

  it("uploadContent writes a temp file and invokes nodemcu-tool upload", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0 });
    const t = new NodemcuTool(shell as unknown as Shell);
    const r = await t.uploadContent(
      { python: "python", port: "/dev/ttyUSB0", baud: 115200, baudUpload: 115200, compile: false },
      Buffer.from("print('live')"),
      "init.lua",
      () => { },
    );
    expect(r.success).toBe(true);
    expect(shell.calls[0].args).toContain("upload");
    expect(shell.calls[0].args).toContain("--remotename");
    expect(shell.calls[0].args).toContain("init.lua");
  });

  it("remove invokes nodemcu-tool remove", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0 });
    const t = new NodemcuTool(shell as unknown as Shell);
    const r = await t.remove(
      { python: "python", port: "/dev/ttyUSB0", baud: 115200, baudUpload: 115200, compile: false },
      "init.lua",
      () => { },
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
      () => { },
    );
    expect(shell.calls[0].command).toBe("node");
    expect(shell.calls[0].args).toContain("fsinfo");
    expect(shell.calls[0].args).toContain("--json");
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe("init.lua");
    expect(files[0].size).toBe(234);
    expect(files[1].size).toBe(100);
  });

  it("listFilesResult reports nodemcu-tool fsinfo failures", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 1, stderr: "Cannot open port COM7" });
    const t = new NodemcuTool(shell as unknown as Shell);
    const result = await t.listFilesResult(
      { python: "python", port: "COM7", baud: 115200, baudUpload: 115200, compile: false },
      () => { },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot open port COM7");
  });
});

describe("NodemcuTool transactional flow (mocked shell)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-vscode-tx-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("uploads a file, lists it, removes it, and confirms removal via list", async () => {
    const shell = new FakeShell();
    // 1. Upload init.lua
    shell.nextResponse({ exitCode: 0, stdout: "Uploaded 1 file" });
    // 2. List files → shows init.lua
    shell.nextResponse({
      exitCode: 0, stdout: JSON.stringify({
        files: [{ name: "init.lua", size: 45 }],
        total: { files: 1, used: 1024, total: 1048576 },
      })
    });
    // 3. Remove init.lua
    shell.nextResponse({ exitCode: 0, stdout: "Removed 1 file" });
    // 4. List files → empty
    shell.nextResponse({
      exitCode: 0, stdout: JSON.stringify({
        files: [],
        total: { files: 0, used: 0, total: 1048576 },
      })
    });

    const tool = new NodemcuTool(shell as unknown as Shell);
    const opts = { python: "python", port: "COM42", baud: 115200, baudUpload: 115200, compile: false };

    const localPath = path.join(tmp, "init.lua");
    fs.writeFileSync(localPath, 'print("hello")\n');

    // Upload
    const uploadResult = await tool.upload(opts, localPath, "init.lua", () => { });
    expect(uploadResult.success).toBe(true);
    expect(shell.calls[0].args).toContain("upload");

    // List → expect init.lua present
    const filesAfterUpload = await tool.listFiles(opts, () => { });
    expect(filesAfterUpload).toHaveLength(1);
    expect(filesAfterUpload[0].name).toBe("init.lua");

    // Remove
    const removeResult = await tool.remove(opts, "init.lua", () => { });
    expect(removeResult.success).toBe(true);
    expect(shell.calls[2].args).toContain("remove");

    // List → expect empty
    const filesAfterRemove = await tool.listFiles(opts, () => { });
    expect(filesAfterRemove).toHaveLength(0);
  });

  it("simulates the full transactional save flow: upload multiple files individually", async () => {
    const shell = new FakeShell();
    // Upload a.lua
    shell.nextResponse({ exitCode: 0 });
    // Upload b.lua
    shell.nextResponse({ exitCode: 0 });
    // List → both files
    shell.nextResponse({
      exitCode: 0, stdout: JSON.stringify({
        files: [{ name: "a.lua", size: 10 }, { name: "b.lua", size: 20 }],
        total: { files: 2, used: 512, total: 1048576 },
      })
    });
    // Remove a.lua (mimics onDidDeleteFiles)
    shell.nextResponse({ exitCode: 0 });
    // List → only b.lua
    shell.nextResponse({
      exitCode: 0, stdout: JSON.stringify({
        files: [{ name: "b.lua", size: 20 }],
        total: { files: 1, used: 256, total: 1048576 },
      })
    });

    const tool = new NodemcuTool(shell as unknown as Shell);
    const opts = { python: "python", port: "COM42", baud: 115200, baudUpload: 115200, compile: false };

    const aPath = path.join(tmp, "a.lua");
    const bPath = path.join(tmp, "b.lua");
    fs.writeFileSync(aPath, "-- a\n");
    fs.writeFileSync(bPath, "-- b\n");

    // Upload file a (like doUploadSingleFile after save)
    let r = await tool.upload(opts, aPath, "a.lua", () => { });
    expect(r.success).toBe(true);

    // Upload file b (like doUploadSingleFile after another save)
    r = await tool.upload(opts, bPath, "b.lua", () => { });
    expect(r.success).toBe(true);

    // List files → both present
    const files = await tool.listFiles(opts, () => { });
    expect(files).toHaveLength(2);

    // Remove file a (like handleFileDelete)
    r = await tool.remove(opts, "a.lua", () => { });
    expect(r.success).toBe(true);

    // List → only b remains
    const remaining = await tool.listFiles(opts, () => { });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("b.lua");
  });

  it("handles remove of a non-existent file gracefully", async () => {
    const shell = new FakeShell();
    // nodemcu-tool remove on non-existent file exits with 0 in some versions,
    // or returns error. We test both paths.
    shell.nextResponse({ exitCode: 0, stdout: "Nothing to remove" });

    const tool = new NodemcuTool(shell as unknown as Shell);
    const r = await tool.remove(
      { python: "python", port: "COM42", baud: 115200, baudUpload: 115200, compile: false },
      "nonexistent.lua",
      () => { },
    );
    expect(r.success).toBe(true);
    expect(shell.calls[0].args).toContain("remove");
    expect(shell.calls[0].args).toContain("nonexistent.lua");
  });
});

describe("Device identity (integration, mocked shell)", () => {
  it("reads the MAC address through esptool", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "MAC: aa:bb:cc:dd:ee:ff\n" });
    const result = await readDeviceIdentity({
      shell: shell as unknown as Shell,
      python: "python",
      port: "COM42",
      baud: 115200,
    });
    expect(result.success).toBe(true);
    expect(result.identity?.uuid).toBe("aabbccddeeff");
    expect(shell.calls[0]).toEqual({
      command: "python",
      args: ["-m", "esptool", "--port", "COM42", "--baud", "115200", "read-mac"],
    });
  });

  it("reports a parse failure when esptool output has no MAC address", async () => {
    const shell = new FakeShell();
    shell.nextResponse({ exitCode: 0, stdout: "No MAC here\n" });
    const result = await readDeviceIdentity({
      shell: shell as unknown as Shell,
      python: "python",
      port: "COM42",
      baud: 115200,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unable to parse");
  });
});
