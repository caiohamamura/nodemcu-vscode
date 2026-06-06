import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { resolveLuaModule, resolveAllLuaModules, validateLuaModuleSource } from "../../src/luaPicker/luaModuleResolver";
import { defaultConfig } from "../../src/config/nodemcuIni";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nodemcu-vscode-lua-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("validateLuaModuleSource", () => {
  it("accepts a local path", () => {
    expect(validateLuaModuleSource("lua/bh1750.lua")).toEqual({ ok: true });
  });

  it("accepts a valid http(s) URL", () => {
    expect(validateLuaModuleSource("https://example.com/x.lua")).toEqual({ ok: true });
  });

  it("rejects an empty string", () => {
    const r = validateLuaModuleSource("");
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid URL", () => {
    const r = validateLuaModuleSource("https://");
    expect(r.ok).toBe(false);
  });

  it("rejects path traversal", () => {
    const r = validateLuaModuleSource("../../../etc/passwd");
    expect(r.ok).toBe(false);
  });
});

describe("resolveLuaModule", () => {
  it("resolves a local file relative to workspace", async () => {
    const file = path.join(tmp, "lua", "bh1750.lua");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "-- bh1750");
    const r = await resolveLuaModule(tmp, "/fw", {
      name: "bh1750",
      source: "lua/bh1750.lua",
      isRemote: false,
    });
    expect(r.exists).toBe(true);
    expect(r.resolvedLocalPath).toBe(file);
  });

  it("falls back to firmware/lua_modules/<name>/<basename>", async () => {
    const fwRoot = path.join(tmp, "fw");
    const file = path.join(fwRoot, "lua_modules", "bh1750", "bh1750.lua");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "-- bh1750");
    const r = await resolveLuaModule(tmp, fwRoot, {
      name: "bh1750",
      source: "lua/bh1750.lua",
      isRemote: false,
    });
    expect(r.exists).toBe(true);
    expect(r.resolvedLocalPath).toBe(file);
  });

  it("returns exists=false for missing local file", async () => {
    const r = await resolveLuaModule(tmp, "/fw", {
      name: "missing",
      source: "lua/missing.lua",
      isRemote: false,
    });
    expect(r.exists).toBe(false);
  });

  it("returns exists=false for remote URL (no local resolution)", async () => {
    const r = await resolveLuaModule(tmp, "/fw", {
      name: "gossip",
      source: "https://example.com/gossip.lua",
      isRemote: true,
    });
    expect(r.exists).toBe(false);
    expect(r.resolvedLocalPath).toBeNull();
  });
});

describe("resolveAllLuaModules", () => {
  it("resolves multiple modules in parallel", async () => {
    const cfg = defaultConfig();
    cfg.lua_modules.a = "lua/a.lua";
    cfg.lua_modules.b = "lua/b.lua";
    await fs.mkdir(path.join(tmp, "lua"), { recursive: true });
    await fs.writeFile(path.join(tmp, "lua", "a.lua"), "a");
    await fs.writeFile(path.join(tmp, "lua", "b.lua"), "b");
    const r = await resolveAllLuaModules(tmp, "/fw", cfg);
    expect(r).toHaveLength(2);
    expect(r.every((m) => m.exists)).toBe(true);
  });
});
