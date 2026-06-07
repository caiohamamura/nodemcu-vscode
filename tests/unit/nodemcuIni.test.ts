import { describe, it, expect } from "vitest";
import {
  parseIni,
  serializeIni,
  defaultConfig,
  setCModule,
  setLuaModule,
  getLuaModuleEntries,
} from "../../src/config/nodemcuIni";

describe("parseIni", () => {
  it("returns defaults on empty input", () => {
    const cfg = parseIni("");
    expect(cfg.nodemcu.firmware_path).toBeUndefined();
    expect(cfg.nodemcu.lua_version).toBe("53");
    expect(cfg.nodemcu.baud).toBe(115200);
  });

  it("parses all nodemcu section fields", () => {
    const ini = `
[nodemcu]
firmware_path = /opt/firmware
lua_version = 51
lua_number_integral = true
port = /dev/ttyUSB0
baud = 921600
flash_mode = qio
flash_freq = 80m
flash_size = 4M
`;
    const cfg = parseIni(ini);
    expect(cfg.nodemcu.firmware_path).toBe("/opt/firmware");
    expect(cfg.nodemcu.lua_version).toBe("51");
    expect(cfg.nodemcu.lua_number_integral).toBe(true);
    expect(cfg.nodemcu.port).toBe("/dev/ttyUSB0");
    expect(cfg.nodemcu.baud).toBe(921600);
    expect(cfg.nodemcu.flash_mode).toBe("qio");
    expect(cfg.nodemcu.flash_freq).toBe("80m");
    expect(cfg.nodemcu.flash_size).toBe("4M");
  });

  it("falls back to defaults for invalid enum values", () => {
    const ini = `
[nodemcu]
lua_version = 99
flash_mode = bogus
flash_freq = 999
`;
    const cfg = parseIni(ini);
    expect(cfg.nodemcu.lua_version).toBe("53");
    expect(cfg.nodemcu.flash_mode).toBe("dio");
    expect(cfg.nodemcu.flash_freq).toBe("80m");
  });

  it("parses c_modules and lua_modules sections", () => {
    const ini = `
[c_modules]
wifi = true
mqtt = false
ADC = true

[lua_modules]
bh1750 = lua/bh1750.lua
gossip = https://example.com/gossip.lua
`;
    const cfg = parseIni(ini);
    expect(cfg.c_modules.wifi).toBe(true);
    expect(cfg.c_modules.mqtt).toBe(false);
    expect(cfg.c_modules.adc).toBe(true);
    expect(cfg.lua_modules.bh1750).toBe("lua/bh1750.lua");
    expect(cfg.lua_modules.gossip).toBe("https://example.com/gossip.lua");
  });

  it("parses extra_files into structured form", () => {
    const ini = `
[flash]
extra_files = spiffs.bin@0x100000, lfs.img@0x200000
`;
    const cfg = parseIni(ini);
    expect(cfg.flash.extra_files).toEqual([
      { path: "spiffs.bin", offset: "0x100000" },
      { path: "lfs.img", offset: "0x200000" },
    ]);
  });

  it("coerces truthy/falsy strings correctly", () => {
    const ini = `
[nodemcu]
lua_number_integral = yes
lua_number_64bits = no
verbose = 1
parallel = 0
`;
    const cfg = parseIni(ini);
    expect(cfg.nodemcu.lua_number_integral).toBe(true);
    expect(cfg.nodemcu.lua_number_64bits).toBe(false);
    expect(cfg.nodemcu.verbose).toBe(true);
    expect(cfg.nodemcu.parallel).toBe(false);
  });
});

describe("serializeIni", () => {
  it("produces a parseable roundtrip", () => {
    const original = defaultConfig();
    original.nodemcu.firmware_path = "/custom/path";
    original.nodemcu.port = "/dev/ttyACM0";
    original.nodemcu.baud = 230400;
    original.c_modules.wifi = true;
    original.c_modules.mqtt = false;
    original.lua_modules.bh1750 = "lua/bh1750.lua";
    original.flash.extra_files = [{ path: "spiffs.bin", offset: "0x100000" }];
    const serialized = serializeIni(original);
    const reparsed = parseIni(serialized);
    expect(reparsed.nodemcu.firmware_path).toBe("/custom/path");
    expect(reparsed.nodemcu.port).toBe("/dev/ttyACM0");
    expect(reparsed.nodemcu.baud).toBe(230400);
    expect(reparsed.c_modules.wifi).toBe(true);
    expect(reparsed.c_modules.mqtt).toBe(false);
    expect(reparsed.lua_modules.bh1750).toBe("lua/bh1750.lua");
    expect(reparsed.flash.extra_files).toEqual([{ path: "spiffs.bin", offset: "0x100000" }]);
  });
});

describe("setCModule / setLuaModule", () => {
  it("returns a new config with the c_module toggled", () => {
    const c = defaultConfig();
    const c2 = setCModule(c, "wifi", true);
    expect(c).not.toBe(c2);
    expect(c2.c_modules.wifi).toBe(true);
    expect(c.c_modules.wifi).toBeUndefined();
  });

  it("preserves other modules when adding one", () => {
    let c = defaultConfig();
    c = setCModule(c, "wifi", true);
    c = setCModule(c, "mqtt", true);
    expect(c.c_modules.wifi).toBe(true);
    expect(c.c_modules.mqtt).toBe(true);
  });

  it("setLuaModule lowercases the name and stores the source", () => {
    const c = setLuaModule(defaultConfig(), "BH1750", "lua/bh1750.lua");
    expect(c.lua_modules.BH1750).toBe("lua/bh1750.lua");
  });
});

describe("getLuaModuleEntries", () => {
  it("flags remote URLs", () => {
    const c = defaultConfig();
    c.lua_modules.bh1750 = "lua/bh1750.lua";
    c.lua_modules.gossip = "https://example.com/gossip.lua";
    const entries = getLuaModuleEntries(c);
    const bh1750 = entries.find((e) => e.name === "bh1750")!;
    const gossip = entries.find((e) => e.name === "gossip")!;
    expect(bh1750.isRemote).toBe(false);
    expect(gossip.isRemote).toBe(true);
  });
});
