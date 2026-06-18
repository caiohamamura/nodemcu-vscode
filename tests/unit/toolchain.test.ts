import { describe, it, expect } from "vitest";
import { cmakeConfigureCommand, cmakeBuildCommand, esptoolFlashCommand, normalizeFlashSize, detectHostCompiler } from "../../src/build/toolchain";
import { Shell } from "../../src/util/shell";

class WhichShell extends Shell {
  constructor(private available: Set<string>) { super(); }
  async which(binary: string): Promise<string | null> {
    return this.available.has(binary) ? `/usr/bin/${binary}` : null;
  }
}

describe("detectHostCompiler", () => {
  it("returns the first available compiler in preference order (cc > gcc > clang)", async () => {
    expect(await detectHostCompiler(new WhichShell(new Set(["gcc", "clang"])))).toBe("/usr/bin/gcc");
    expect(await detectHostCompiler(new WhichShell(new Set(["clang"])))).toBe("/usr/bin/clang");
    expect(await detectHostCompiler(new WhichShell(new Set(["cc", "gcc"])))).toBe("/usr/bin/cc");
  });

  it("returns null when no host compiler is on PATH", async () => {
    expect(await detectHostCompiler(new WhichShell(new Set()))).toBeNull();
  });
});

describe("cmakeConfigureCommand", () => {
  it("produces the correct invocation", () => {
    const cmd = cmakeConfigureCommand({
      firmwarePath: "/fw",
      buildDir: "/fw/build",
      generator: "Ninja",
      luaVersion: "53",
      luaNumberIntegral: false,
      luaNumber64bits: false,
      verbose: false,
    });
    expect(cmd.command).toBe("cmake");
    expect(cmd.args).toContain("-S");
    expect(cmd.args[cmd.args.indexOf("-S") + 1]).toBe("/fw");
    expect(cmd.args).toContain("-DLUA=53");
    expect(cmd.args).not.toContain(expect.stringMatching(/CMAKE_TOOLCHAIN_FILE/));
  });

  it("uses an explicit cmake executable when provided", () => {
    const cmd = cmakeConfigureCommand({
      cmake: "/managed/cmake",
      firmwarePath: "/fw",
      buildDir: "/fw/build",
      generator: "Ninja",
      luaVersion: "53",
      luaNumberIntegral: false,
      luaNumber64bits: false,
      verbose: false,
    });
    expect(cmd.command).toBe("/managed/cmake");
  });

  it("includes LUA_NUMBER_INTEGRAL when set", () => {
    const cmd = cmakeConfigureCommand({
      firmwarePath: "/fw",
      buildDir: "/fw/build",
      generator: "Unix Makefiles",
      luaVersion: "51",
      luaNumberIntegral: true,
      luaNumber64bits: false,
      verbose: true,
    });
    expect(cmd.args).toContain("-DLUA=51");
    expect(cmd.args).toContain("-DLUA_NUMBER_INTEGRAL=ON");
    expect(cmd.args).toContain("-DCMAKE_VERBOSE_MAKEFILE=ON");
  });
});

describe("cmakeBuildCommand", () => {
  it("includes -j N when parallel", () => {
    const cmd = cmakeBuildCommand({ buildDir: "/fw/build", parallel: true, jobCount: 4, verbose: false });
    expect(cmd.args).toContain("--build");
    expect(cmd.args).toContain("/fw/build");
    expect(cmd.args).toContain("-j");
    expect(cmd.args[cmd.args.indexOf("-j") + 1]).toBe("4");
  });

  it("omits -j when parallel is false", () => {
    const cmd = cmakeBuildCommand({ buildDir: "/fw/build", parallel: false, jobCount: 4, verbose: false });
    expect(cmd.args).not.toContain("-j");
  });

  it("uses an explicit cmake executable when provided", () => {
    const cmd = cmakeBuildCommand({ cmake: "/managed/cmake", buildDir: "/fw/build", parallel: false, jobCount: 4, verbose: false });
    expect(cmd.command).toBe("/managed/cmake");
  });
});

describe("esptoolFlashCommand", () => {
  it("emits write_flash with the standard 0x00000/0x10000 mapping", () => {
    const cmd = esptoolFlashCommand({
      python: "python",
      esptool: "/fw/tools/toolchains/esptool.py",
      port: "/dev/ttyUSB0",
      baud: 115200,
      flashMode: "dio",
      flashFreq: "80m",
      flashSize: "4MB",
      bin0: "/fw/bin/0x00000.bin",
      bin1: "/fw/bin/0x10000.bin",
      extraFiles: [],
    });
    expect(cmd.command).toBe("python");
    expect(cmd.args).toContain("/fw/tools/toolchains/esptool.py");
    expect(cmd.args).toContain("write_flash");
    expect(cmd.args).toContain("0x00000");
    expect(cmd.args).toContain("/fw/bin/0x00000.bin");
    expect(cmd.args).toContain("0x10000");
    expect(cmd.args).toContain("/fw/bin/0x10000.bin");
  });

  it("appends extra files with their offsets", () => {
    const cmd = esptoolFlashCommand({
      python: "python",
      esptool: "esptool.py",
      port: "COM3",
      baud: 921600,
      flashMode: "dio",
      flashFreq: "80m",
      flashSize: "4MB",
      bin0: "0x00000.bin",
      bin1: "0x10000.bin",
      extraFiles: [{ path: "spiffs.bin", offset: "0x100000" }],
    });
    expect(cmd.args).toContain("0x100000");
    expect(cmd.args).toContain("spiffs.bin");
    expect(cmd.args).toContain("--baud");
    expect(cmd.args[cmd.args.indexOf("--baud") + 1]).toBe("921600");
  });
});

describe("normalizeFlashSize", () => {
  it.each([
    ["1M", "1MB"],
    ["4M", "4MB"],
    ["512k", "512KB"],
    ["256K", "256KB"],
    ["8MB", "8MB"],
    ["16M", "16MB"],
    ["detect", "detect"],
    ["keep", "keep"],
    ["  2M  ", "2MB"],
    ["4MB-c1", "4MB-c1"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeFlashSize(input)).toBe(expected);
  });

  it("passes through unknown formats unchanged", () => {
    expect(normalizeFlashSize("weird")).toBe("weird");
    expect(normalizeFlashSize("")).toBe("");
  });
});

describe("esptoolFlashCommand flash_size normalization", () => {
  it("converts 4M to 4MB in the emitted command", () => {
    const cmd = esptoolFlashCommand({
      python: "python3",
      esptool: "esptool",
      port: "/dev/ttyUSB0",
      baud: 115200,
      flashMode: "dio",
      flashFreq: "40m",
      flashSize: "4M",
      bin0: "/fw/bin/0x00000.bin",
      bin1: "/fw/bin/0x10000.bin",
      extraFiles: [],
    });
    const i = cmd.args.indexOf("--flash_size");
    expect(i).toBeGreaterThan(-1);
    expect(cmd.args[i + 1]).toBe("4MB");
  });
});
