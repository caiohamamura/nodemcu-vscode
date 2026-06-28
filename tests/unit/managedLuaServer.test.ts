import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { currentLspTarget, getLspBinaryPath, LUA_LSP_VERSION } from "../../src/lua/managedLuaServer";

describe("managedLuaServer", () => {
  it("determines a valid platform and architecture target", () => {
    const target = currentLspTarget();
    expect(["win32", "linux", "darwin"]).toContain(target.platform);
    expect(["x64", "arm64", "ia32"]).toContain(target.arch);
    expect(["zip", "tar.gz"]).toContain(target.ext);

    if (target.platform === "win32") {
      expect(target.ext).toBe("zip");
    } else {
      expect(target.ext).toBe("tar.gz");
    }
  });

  it("constructs correct binary path", () => {
    const storageRoot = "/mock/storage";
    const binaryPath = getLspBinaryPath(storageRoot);
    
    expect(binaryPath).toContain(path.join("lua-language-server", LUA_LSP_VERSION, "bin"));
    if (process.platform === "win32") {
      expect(binaryPath.endsWith("lua-language-server.exe")).toBe(true);
    } else {
      expect(binaryPath.endsWith("lua-language-server")).toBe(true);
    }
  });
});
