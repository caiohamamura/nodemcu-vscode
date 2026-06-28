import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { mapFirmwareAPI, generateEmmyLuaStub, generateMarkdownReport } from "../../src/firmware/firmwareMapper";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nodemcu-mapper-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("firmwareMapper", () => {
  it("correctly parses C modules, extracts comments, and maps subtables", async () => {
    const fw = path.join(tmp, "fw");
    await fs.mkdir(path.join(fw, "app", "modules"), { recursive: true });

    const cFileContent = `
// Restarts the chip immediately.
static int node_restart( lua_State* L ) {
  return 0;
}

// Deep sleep mode.
// Microseconds to sleep.
static int node_dsleep( lua_State* L ) {
  return 0;
}

LROT_BEGIN(node)
  LROT_FUNCENTRY( restart, node_restart )
  LROT_FUNCENTRY( dsleep, node_dsleep )
  LROT_NUMENTRY( CPU80, 80 )
LROT_END(node, NULL, 0)

NODEMCU_MODULE(NODE, "node", node, luaopen_node)
    `;
    await fs.writeFile(path.join(fw, "app", "modules", "node.c"), cFileContent);

    // Add an optional C module with sub-tables using LUA_REG_TYPE
    const wifiFileContent = `
// Setup WiFi AP.
static int wifi_ap_setup( lua_State* L ) {
  return 0;
}

static const LUA_REG_TYPE wifi_ap_map[] = {
  { LSTRKEY( "setup" ), LFUNCVAL( wifi_ap_setup ) },
  { LNILKEY, LNILVAL }
};

static const LUA_REG_TYPE wifi_map[] = {
  { LSTRKEY( "ap" ), LROVAL( wifi_ap_map ) },
  { LSTRKEY( "STATION" ), LNVAL( 1 ) },
  { LNILKEY, LNILVAL }
};

NODEMCU_MODULE(WIFI, "wifi", wifi_map, luaopen_wifi)
    `;
    await fs.writeFile(path.join(fw, "app", "modules", "wifi.c"), wifiFileContent);

    // Add a Lua module
    await fs.mkdir(path.join(fw, "lua_modules", "bh1750"), { recursive: true });
    const luaFileContent = `
-- bh1750 light sensor library
local M = {}
function M.init(sda, scl)
end
function M:read()
  return 100
end
M.SOME_CONST = 42
return M
    `;
    await fs.writeFile(path.join(fw, "lua_modules", "bh1750", "bh1750.lua"), luaFileContent);

    const modules = await mapFirmwareAPI(fw);
    expect(modules).toHaveLength(3);

    // Verify node module (C module)
    const nodeMod = modules.find((m) => m.name === "node");
    expect(nodeMod).toBeDefined();
    expect(nodeMod?.type).toBe("C");
    expect(nodeMod?.functions).toHaveLength(2);
    expect(nodeMod?.constants).toHaveLength(1);

    const restartFunc = nodeMod?.functions.find((f) => f.luaName === "restart");
    expect(restartFunc?.description).toBe("Restarts the chip immediately.");

    const dsleepFunc = nodeMod?.functions.find((f) => f.luaName === "dsleep");
    expect(dsleepFunc?.description).toBe("Deep sleep mode. Microseconds to sleep.");

    const cpuConst = nodeMod?.constants.find((c) => c.luaName === "CPU80");
    expect(cpuConst?.value).toBe("80");

    // Verify wifi module with sub-tables (C module)
    const wifiMod = modules.find((m) => m.name === "wifi");
    expect(wifiMod).toBeDefined();
    expect(Object.keys(wifiMod?.subtables || {})).toContain("ap");
    expect(wifiMod?.subtables.ap.functions).toHaveLength(1);
    expect(wifiMod?.subtables.ap.functions[0].luaName).toBe("setup");
    expect(wifiMod?.subtables.ap.functions[0].description).toBe("Setup WiFi AP.");
    expect(wifiMod?.constants[0].luaName).toBe("STATION");
    expect(wifiMod?.constants[0].value).toBe("1");

    // Verify bh1750 module (Lua module)
    const bhMod = modules.find((m) => m.name === "bh1750");
    expect(bhMod).toBeDefined();
    expect(bhMod?.type).toBe("Lua");
    expect(bhMod?.functions).toHaveLength(2);
    expect(bhMod?.functions.map((f) => f.luaName)).toContain("init");
    expect(bhMod?.functions.map((f) => f.luaName)).toContain("read");
    expect(bhMod?.constants.map((c) => c.luaName)).toContain("SOME_CONST");

    // Test stubs generation
    const stubs = generateEmmyLuaStub(modules);
    expect(stubs).toContain("---@class node");
    expect(stubs).toContain("---@field restart fun(...)");
    expect(stubs).toContain("---@field CPU80 number");
    expect(stubs).toContain("node = node or {}");

    expect(stubs).toContain("---@class wifi");
    expect(stubs).toContain("---@field ap wifi_ap");
    expect(stubs).toContain("---@class wifi_ap");
    expect(stubs).toContain("---@field setup fun(...)");
    expect(stubs).toContain("wifi = wifi or {}");

    expect(stubs).toContain("---@class bh1750");
    expect(stubs).toContain("---@field init fun(...)");
    expect(stubs).toContain("---@field read fun(...)");
    expect(stubs).toContain("bh1750 = bh1750 or {}");

    // Test markdown report generation
    const md = generateMarkdownReport(modules);
    expect(md).toContain("# NodeMCU Firmware API Map");
    expect(md).toContain("## node (C Module)");
    expect(md).toContain("`node.restart()` - *Restarts the chip immediately.*");
    expect(md).toContain("## bh1750 (Lua Module)");
  });
});
