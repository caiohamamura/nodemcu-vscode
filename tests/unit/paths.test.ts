import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  resolveFirmwarePath,
  defaultBuildDir,
  userModulesHeader,
  esptoolScript,
  luaModulesDir,
  appModulesDir,
  binOutput,
  cModuleNameFromFile,
  isOptionalCModule,
  toolchainBinDirs,
} from "../../src/util/paths";

describe("path utilities", () => {
  let tmpFw: string;

  beforeEach(() => {
    tmpFw = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-paths-test-"));
    fs.writeFileSync(path.join(tmpFw, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.24)\n");
    fs.mkdirSync(path.join(tmpFw, "app", "coap"), { recursive: true });
    fs.writeFileSync(path.join(tmpFw, "app", "coap", "CMakeLists.txt"), "add_library(coap STATIC coap.c)\n");
  });

  afterEach(() => {
    fs.rmSync(tmpFw, { recursive: true, force: true });
  });

  describe("resolveFirmwarePath", () => {
    it("resolves a relative path against workspaceRoot", () => {
      const resolved = resolveFirmwarePath(path.dirname(tmpFw), path.basename(tmpFw));
      expect(resolved).toBe(tmpFw);
    });

    it("returns absolute paths unchanged", () => {
      expect(resolveFirmwarePath("/anywhere", tmpFw)).toBe(tmpFw);
    });

    it("throws if path does not exist", () => {
      expect(() => resolveFirmwarePath("/anywhere", "/does/not/exist")).toThrow(/does not exist/);
    });

    it("throws if path is missing CMakeLists.txt", () => {
      // Use a real existing directory without CMakeLists.txt so the check under
      // test is reached (a hardcoded "/tmp" does not exist for Node on Windows
      // and trips the earlier does-not-exist guard instead).
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-paths-empty-"));
      try {
        expect(() => resolveFirmwarePath("/anywhere", empty)).toThrow(/CMakeLists\.txt/);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe("helpers", () => {
    it("defaultBuildDir is firmware/build", () => {
      expect(defaultBuildDir("/fw")).toBe(path.join("/fw", "build"));
    });

    it("userModulesHeader is firmware/app/include/user_modules.h", () => {
      expect(userModulesHeader("/fw")).toBe(path.join("/fw", "app", "include", "user_modules.h"));
    });

    it("esptoolScript is firmware/tools/toolchains/esptool.py", () => {
      expect(esptoolScript("/fw")).toBe(path.join("/fw", "tools", "toolchains", "esptool.py"));
    });

    it("luaModulesDir is firmware/lua_modules", () => {
      expect(luaModulesDir("/fw")).toBe(path.join("/fw", "lua_modules"));
    });

    it("appModulesDir is firmware/app/modules", () => {
      expect(appModulesDir("/fw")).toBe(path.join("/fw", "app", "modules"));
    });

    it("binOutput is firmware/bin", () => {
      expect(binOutput("/fw")).toBe(path.join("/fw", "bin"));
    });
  });

  describe("cModuleNameFromFile", () => {
    it("strips .c and lowercases", () => {
      expect(cModuleNameFromFile("Wifi.c")).toBe("wifi");
      expect(cModuleNameFromFile("MQTT.c")).toBe("mqtt");
    });
  });

  describe("isOptionalCModule", () => {
    it("returns true when app/<name>/CMakeLists.txt exists", () => {
      expect(isOptionalCModule(tmpFw, "coap")).toBe(true);
    });

    it("returns false when subdir does not exist", () => {
      expect(isOptionalCModule(tmpFw, "nonexistent")).toBe(false);
    });
  });

  describe("toolchainBinDirs", () => {
    it("returns [] when no toolchains dir exists", () => {
      expect(toolchainBinDirs(tmpFw)).toEqual([]);
    });

    it("collects top-level bin and nested <target>/bin (where bare 'as' lives)", () => {
      const tc = path.join(tmpFw, "tools", "toolchains", "esp8266-xtensa-lx106-elf-1.22.0");
      const topBin = path.join(tc, "bin");
      const targetBin = path.join(tc, "xtensa-lx106-elf", "bin");
      fs.mkdirSync(topBin, { recursive: true });
      fs.mkdirSync(targetBin, { recursive: true });
      const dirs = toolchainBinDirs(tmpFw);
      expect(dirs).toContain(topBin);
      expect(dirs).toContain(targetBin);
    });

    it("skips loose files and toolchains without a bin dir", () => {
      const root = path.join(tmpFw, "tools", "toolchains");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "esptool.py"), "# not a dir\n");
      fs.mkdirSync(path.join(root, "ninja"), { recursive: true }); // dir, but no bin/
      expect(toolchainBinDirs(tmpFw)).toEqual([]);
    });
  });
});
