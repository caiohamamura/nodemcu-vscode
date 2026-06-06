import { describe, it, expect } from "vitest";
import * as path from "node:path";
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
} from "../../src/util/paths";

describe("path utilities", () => {
  const FIXTURE_ROOT = path.resolve(__dirname, "../fixtures/fake-firmware");

  describe("resolveFirmwarePath", () => {
    it("resolves a relative path against workspaceRoot", () => {
      const resolved = resolveFirmwarePath(path.dirname(FIXTURE_ROOT), "fake-firmware");
      expect(resolved).toBe(FIXTURE_ROOT);
    });

    it("returns absolute paths unchanged", () => {
      expect(resolveFirmwarePath("/anywhere", FIXTURE_ROOT)).toBe(FIXTURE_ROOT);
    });

    it("throws if path does not exist", () => {
      expect(() => resolveFirmwarePath("/anywhere", "/does/not/exist")).toThrow(/does not exist/);
    });

    it("throws if path is missing CMakeLists.txt", () => {
      expect(() => resolveFirmwarePath("/anywhere", "/tmp")).toThrow(/CMakeLists\.txt/);
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
      expect(isOptionalCModule(FIXTURE_ROOT, "coap")).toBe(true);
    });

    it("returns false when subdir does not exist", () => {
      expect(isOptionalCModule(FIXTURE_ROOT, "nonexistent")).toBe(false);
    });
  });
});
