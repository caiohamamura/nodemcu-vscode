import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { listLuaModulesFromFirmware, listCModules } from "../../src/luaPicker/moduleList";

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
