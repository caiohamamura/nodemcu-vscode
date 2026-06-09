import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { listLuaModulesFromFirmware, listCModules, selectMainFileForConfig } from "../../src/luaPicker/moduleList";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nodemcu-vscode-pick-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("listLuaModulesFromFirmware", () => {
  it("returns an empty list when lua_modules dir is missing", async () => {
    const mods = await listLuaModulesFromFirmware(tmp);
    expect(mods).toEqual([]);
  });

  it("scans lua_modules and extracts the description from the first -- line", async () => {
    const fw = path.join(tmp, "fw");
    const dir = path.join(fw, "lua_modules", "bh1750");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "bh1750.lua"), "-- bh1750 ambient light sensor\nlocal M={}\nreturn M\n");
    await fs.writeFile(path.join(dir, "bh1750_Example1.lua"), "print('example')");
    const mods = await listLuaModulesFromFirmware(fw);
    expect(mods).toHaveLength(1);
    expect(mods[0].name).toBe("bh1750");
    expect(mods[0].description).toBe("bh1750 ambient light sensor");
    expect(mods[0].mainFile).toBe(path.join(dir, "bh1750.lua"));
    expect(mods[0].examples).toContain(path.join(dir, "bh1750_Example1.lua"));
  });

  it("ignores directories without a main .lua file", async () => {
    const fw = path.join(tmp, "fw");
    const dir = path.join(fw, "lua_modules", "broken");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "README.md"), "no lua file");
    const mods = await listLuaModulesFromFirmware(fw);
    expect(mods).toEqual([]);
  });

  it("selects the directory-named file over hyphenated examples (ds18b20 pattern)", async () => {
    const fw = path.join(tmp, "fw");
    const dir = path.join(fw, "lua_modules", "ds18b20");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "ds18b20.lua"), "-- ds18b20 library\nreturn {}\n");
    await fs.writeFile(path.join(dir, "ds18b20-example.lua"), "require('ds18b20')\n");
    await fs.writeFile(path.join(dir, "ds18b20-integer.lua"), "-- integer variant\nreturn {}\n");
    await fs.writeFile(path.join(dir, "ds18b20-web.lua"), "require('ds18b20')\n");
    const mods = await listLuaModulesFromFirmware(fw);
    expect(mods).toHaveLength(1);
    expect(mods[0].mainFile).toBe(path.join(dir, "ds18b20.lua"));
    expect(mods[0].examples).toContain(path.join(dir, "ds18b20-example.lua"));
    expect(mods[0].examples).toContain(path.join(dir, "ds18b20-web.lua"));
  });

  it("selects the directory-named file over prefix examples (yeelink pattern)", async () => {
    const fw = path.join(tmp, "fw");
    const dir = path.join(fw, "lua_modules", "yeelink");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "yeelink_lib.lua"), "-- yeelink lib\nreturn {}\n");
    await fs.writeFile(path.join(dir, "Example_for_Yeelink_Lib.lua"), "require('yeelink_lib')\n");
    const mods = await listLuaModulesFromFirmware(fw);
    expect(mods).toHaveLength(1);
    expect(mods[0].mainFile).toBe(path.join(dir, "yeelink_lib.lua"));
  });

  it("selects the directory-named file for case-insensitive match (hdc1000 pattern)", async () => {
    const fw = path.join(tmp, "fw");
    const dir = path.join(fw, "lua_modules", "hdc1000");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "HDC1000.lua"), "-- HDC1000 library\nreturn {}\n");
    await fs.writeFile(path.join(dir, "HDC1000-example.lua"), "require('HDC1000')\n");
    const mods = await listLuaModulesFromFirmware(fw);
    expect(mods).toHaveLength(1);
    expect(mods[0].mainFile).toBe(path.join(dir, "HDC1000.lua"));
  });

  it("selects the directory-named file over http-example (http pattern)", async () => {
    const fw = path.join(tmp, "fw");
    const dir = path.join(fw, "lua_modules", "http");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "httpserver.lua"), "-- http server\nreturn {}\n");
    await fs.writeFile(path.join(dir, "http-example.lua"), "require('httpserver')\n");
    const mods = await listLuaModulesFromFirmware(fw);
    expect(mods).toHaveLength(1);
    expect(mods[0].mainFile).toBe(path.join(dir, "httpserver.lua"));
  });

  it("selects the directory-named file for liquidcrystal over helper files", async () => {
    const fw = path.join(tmp, "fw");
    const dir = path.join(fw, "lua_modules", "liquidcrystal");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "liquidcrystal.lua"), "-- liquidcrystal\nreturn {}\n");
    await fs.writeFile(path.join(dir, "lc-gpio4bit.lua"), "-- gpio helper\n");
    await fs.writeFile(path.join(dir, "lc-gpio8bit.lua"), "-- gpio helper\n");
    await fs.writeFile(path.join(dir, "lc-i2c4bit.lua"), "-- i2c helper\n");
    const mods = await listLuaModulesFromFirmware(fw);
    expect(mods).toHaveLength(1);
    expect(mods[0].mainFile).toBe(path.join(dir, "liquidcrystal.lua"));
  });
});

describe("selectMainFileForConfig", () => {
  it("returns mainFile when no config is passed", () => {
    const mod = {
      name: "ds18b20",
      description: "",
      mainFile: "/fw/lua_modules/ds18b20/ds18b20.lua",
      dir: "/fw/lua_modules/ds18b20",
      examples: [],
      allFiles: [
        "/fw/lua_modules/ds18b20/ds18b20.lua",
        "/fw/lua_modules/ds18b20/ds18b20-integer.lua",
      ],
    };
    expect(selectMainFileForConfig(mod)).toBe("/fw/lua_modules/ds18b20/ds18b20.lua");
  });

  it("returns integer variant when lua_number_integral is true", () => {
    const mod = {
      name: "ds18b20",
      description: "",
      mainFile: "/fw/lua_modules/ds18b20/ds18b20.lua",
      dir: "/fw/lua_modules/ds18b20",
      examples: [],
      allFiles: [
        "/fw/lua_modules/ds18b20/ds18b20.lua",
        "/fw/lua_modules/ds18b20/ds18b20-integer.lua",
      ],
    };
    expect(selectMainFileForConfig(mod, { lua_number_integral: true }))
      .toBe("/fw/lua_modules/ds18b20/ds18b20-integer.lua");
  });

  it("falls back to mainFile when integer variant does not exist", () => {
    const mod = {
      name: "ds18b20",
      description: "",
      mainFile: "/fw/lua_modules/ds18b20/ds18b20.lua",
      dir: "/fw/lua_modules/ds18b20",
      examples: [],
      allFiles: ["/fw/lua_modules/ds18b20/ds18b20.lua"],
    };
    expect(selectMainFileForConfig(mod, { lua_number_integral: true }))
      .toBe("/fw/lua_modules/ds18b20/ds18b20.lua");
  });

  it("returns mainFile when lua_number_integral is false", () => {
    const mod = {
      name: "ds18b20",
      description: "",
      mainFile: "/fw/lua_modules/ds18b20/ds18b20.lua",
      dir: "/fw/lua_modules/ds18b20",
      examples: [],
      allFiles: [
        "/fw/lua_modules/ds18b20/ds18b20.lua",
        "/fw/lua_modules/ds18b20/ds18b20-integer.lua",
      ],
    };
    expect(selectMainFileForConfig(mod, { lua_number_integral: false }))
      .toBe("/fw/lua_modules/ds18b20/ds18b20.lua");
  });
});

describe("listCModules", () => {
  it("lists core modules from app/modules/*.c and optional ones from subdirs", async () => {
    const fw = path.join(tmp, "fw");
    await fs.mkdir(path.join(fw, "app", "modules"), { recursive: true });
    await fs.writeFile(path.join(fw, "app", "modules", "adc.c"), "// adc");
    await fs.writeFile(path.join(fw, "app", "modules", "MQTT.c"), "// mqtt");
    await fs.mkdir(path.join(fw, "app", "coap"), { recursive: true });
    await fs.writeFile(path.join(fw, "app", "coap", "CMakeLists.txt"), "x");
    await fs.mkdir(path.join(fw, "app", "u8g2lib"), { recursive: true });
    await fs.writeFile(path.join(fw, "app", "u8g2lib", "CMakeLists.txt"), "x");
    const mods = await listCModules(fw);
    const names = mods.map((m) => m.name).sort();
    expect(names).toContain("adc");
    expect(names).toContain("mqtt");
    expect(names).toContain("coap");
    expect(names).toContain("u8g2");
  });
});
