import { describe, it, expect } from "vitest";
import {
  parseIni,
  serializeIni,
  defaultConfig,
  setCModule,
  setLuaModule,
  getLuaModuleEntries,
  addDeviceUuid,
  hasDeviceUuid,
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

  it("parses sync last_timestamp from the sync section", () => {
    const cfg = parseIni(`
[sync]
last_timestamp = 2024-01-15T10:30:00.000Z
`);
    expect(cfg.sync.last_timestamp).toBe("2024-01-15T10:30:00.000Z");
  });

  it("defaults sync.last_timestamp to empty string", () => {
    const cfg = parseIni("");
    expect(cfg.sync.last_timestamp).toBe("");
  });

  it("parses device UUIDs from the devices section", () => {
    const cfg = parseIni(`
[devices]
uuids = aabbccddeeff, 112233445566, aabbccddeeff
`);
    expect(cfg.devices.uuids).toEqual(["aabbccddeeff", "112233445566"]);
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
    original.devices.uuids = ["aabbccddeeff"];
    original.sync.last_timestamp = "2024-06-01T12:00:00.000Z";
    original.flash.extra_files = [{ path: "spiffs.bin", offset: "0x100000" }];
    const serialized = serializeIni(original);
    const reparsed = parseIni(serialized);
    expect(reparsed.nodemcu.firmware_path).toBe("/custom/path");
    expect(reparsed.nodemcu.port).toBe("/dev/ttyACM0");
    expect(reparsed.nodemcu.baud).toBe(230400);
    expect(reparsed.c_modules.wifi).toBe(true);
    expect(reparsed.c_modules.mqtt).toBe(false);
    expect(reparsed.lua_modules.bh1750).toBe("lua/bh1750.lua");
    expect(reparsed.devices.uuids).toEqual(["aabbccddeeff"]);
    expect(reparsed.sync.last_timestamp).toBe("2024-06-01T12:00:00.000Z");
    expect(reparsed.flash.extra_files).toEqual([{ path: "spiffs.bin", offset: "0x100000" }]);
  });

  it("roundtrips a custom ssl_buffer_size", () => {
    const original = defaultConfig();
    original.build.ssl_buffer_size = 8192;
    const reparsed = parseIni(serializeIni(original));
    expect(reparsed.build.ssl_buffer_size).toBe(8192);
  });
});

describe("ssl_buffer_size parsing", () => {
  it("defaults to 16384 when absent", () => {
    expect(parseIni("").build.ssl_buffer_size).toBe(16384);
  });

  it("reads an explicit value from [build]", () => {
    const cfg = parseIni("[build]\nssl_buffer_size = 4096\n");
    expect(cfg.build.ssl_buffer_size).toBe(4096);
  });

  it("falls back to the default for non-positive or invalid values", () => {
    expect(parseIni("[build]\nssl_buffer_size = 0\n").build.ssl_buffer_size).toBe(16384);
    expect(parseIni("[build]\nssl_buffer_size = notanumber\n").build.ssl_buffer_size).toBe(16384);
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

  it("adds and checks device UUIDs without duplicating entries", () => {
    let cfg = defaultConfig();
    cfg = addDeviceUuid(cfg, "AABBCCDDEEFF");
    cfg = addDeviceUuid(cfg, "aabbccddeeff");
    expect(cfg.devices.uuids).toEqual(["aabbccddeeff"]);
    expect(hasDeviceUuid(cfg, "aabbccddeeff")).toBe(true);
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

describe("sync section", () => {
  it("defaultConfig has empty last_timestamp", () => {
    const cfg = defaultConfig();
    expect(cfg.sync.last_timestamp).toBe("");
  });

  it("parseIni defaults last_timestamp to empty when section is missing", () => {
    const cfg = parseIni("[nodemcu]\nport = COM3\n");
    expect(cfg.sync.last_timestamp).toBe("");
  });

  it("parseIni reads last_timestamp from ini", () => {
    const cfg = parseIni("[sync]\nlast_timestamp = 2024-03-15T08:30:00.000Z\n");
    expect(cfg.sync.last_timestamp).toBe("2024-03-15T08:30:00.000Z");
  });

  it("serializeIni preserves last_timestamp through roundtrip", () => {
    const cfg = defaultConfig();
    cfg.sync.last_timestamp = "2025-12-01T00:00:00.000Z";
    const serialized = serializeIni(cfg);
    const reparsed = parseIni(serialized);
    expect(reparsed.sync.last_timestamp).toBe("2025-12-01T00:00:00.000Z");
  });

  it("empty last_timestamp roundtrips as empty string", () => {
    const cfg = defaultConfig();
    cfg.sync.last_timestamp = "";
    const serialized = serializeIni(cfg);
    const reparsed = parseIni(serialized);
    expect(reparsed.sync.last_timestamp).toBe("");
  });

  it("multiple sync entries are parsed correctly", () => {
    const cfg = parseIni(`[sync]
last_timestamp = 2024-06-15T10:00:00.000Z
`);
    expect(cfg.sync.last_timestamp).toBe("2024-06-15T10:00:00.000Z");
  });

  it("extra unknown keys in sync section do not cause errors", () => {
    const cfg = parseIni(`[sync]
last_timestamp = 2024-01-01T00:00:00.000Z
unknown_key = some_value
`);
    expect(cfg.sync.last_timestamp).toBe("2024-01-01T00:00:00.000Z");
  });

  it("sync section coexists with other sections", () => {
    const cfg = parseIni(`[nodemcu]
port = /dev/ttyUSB0
src = my_src

[sync]
last_timestamp = 2024-05-20T12:00:00.000Z

[c_modules]
wifi = true
`);
    expect(cfg.nodemcu.port).toBe("/dev/ttyUSB0");
    expect(cfg.sync.last_timestamp).toBe("2024-05-20T12:00:00.000Z");
    expect(cfg.c_modules.wifi).toBe(true);
  });
});
