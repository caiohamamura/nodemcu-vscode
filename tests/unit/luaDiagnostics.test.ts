import { describe, it, expect } from "vitest";
import { computeLuaDiagnostics, type LuaDiagnosticsContext } from "../../src/lua/luaDiagnostics";

function ctx(overrides: Partial<LuaDiagnosticsContext> = {}): LuaDiagnosticsContext {
  return {
    lfsEnabled: false,
    enabledCModules: new Set(["file", "gpio", "net", "node", "tmr", "uart", "wifi"]),
    knownCModules: new Set(["dht", "mqtt", "u8g2", "ucg", "gpio", "file"]),
    mandatoryCModules: new Set(["file", "gpio", "net", "node", "tmr", "uart", "wifi"]),
    enabledLuaModules: new Set<string>(),
    availableLuaModules: new Set(["ds18b20"]),
    u8g2Available: true,
    u8g2FontCatalog: new Set(["font_6x10_tf", "font_logisoso16_tf"]),
    enabledU8g2Fonts: new Set(["font_6x10_tf"]),
    ucgAvailable: true,
    ucgFontCatalog: new Set(["font_ncenR14_hr"]),
    enabledUcgFonts: new Set<string>(),
    ...overrides,
  };
}

describe("computeLuaDiagnostics", () => {
  it("flags a disabled C module used as a global", () => {
    const d = computeLuaDiagnostics("local t = dht.read(1)\n", ctx());
    expect(d).toHaveLength(1);
    expect(d[0].code).toBe("nodemcu.cModule:dht");
    expect(d[0].message).toContain("dht");
  });

  it("does not flag enabled or mandatory modules", () => {
    expect(computeLuaDiagnostics("gpio.write(1, gpio.HIGH)\n", ctx())).toHaveLength(0);
  });

  it("flags a required Lua module not enabled in [lua_modules]", () => {
    const d = computeLuaDiagnostics('local s = require("ds18b20")\n', ctx());
    expect(d).toHaveLength(1);
    expect(d[0].code).toBe("nodemcu.luaModule:ds18b20");
  });

  it("ignores require() of unknown / user modules", () => {
    expect(computeLuaDiagnostics('require("myhelper")\n', ctx())).toHaveLength(0);
  });

  it("flags a u8g2 font that exists but is not compiled in", () => {
    const d = computeLuaDiagnostics("disp:setFont(u8g2.font_logisoso16_tf)\n", ctx());
    expect(d).toHaveLength(1);
    expect(d[0].code).toBe("nodemcu.u8g2Font:font_logisoso16_tf");
  });

  it("does not flag an already-compiled font", () => {
    expect(computeLuaDiagnostics("disp:setFont(u8g2.font_6x10_tf)\n", ctx())).toHaveLength(0);
  });

  it("flags an unknown font with no quick-fix code", () => {
    const d = computeLuaDiagnostics("disp:setFont(u8g2.font_does_not_exist)\n", ctx());
    expect(d).toHaveLength(1);
    expect(d[0].code).toBe("nodemcu.unknownFont");
  });

  it("ignores references inside comments", () => {
    expect(computeLuaDiagnostics("-- dht.read() and u8g2.font_logisoso16_tf\n", ctx())).toHaveLength(0);
  });

  it("reports each disabled module only once", () => {
    const src = "dht.read(1)\ndht.read(2)\ndht.read(3)\n";
    expect(computeLuaDiagnostics(src, ctx())).toHaveLength(1);
  });

  describe("with LFS enabled", () => {
    it("errors on require() of a known module and suggests node.LFS.get", () => {
      const d = computeLuaDiagnostics('local f = require("fifo")\n', ctx({ lfsEnabled: true }));
      expect(d).toHaveLength(1);
      expect(d[0].severity).toBe("error");
      expect(d[0].code).toBe("nodemcu.lfsRequire:fifo");
      // range spans the whole require("fifo") call so the fix can replace it
      expect(d[0].startCol).toBe('local f = '.length);
      expect(d[0].endCol).toBe('local f = require("fifo")'.length);
    });

    it("errors on every literal require(), even unknown modules", () => {
      const d = computeLuaDiagnostics('require("fifo")\nrequire("weird_thing")\n', ctx({ lfsEnabled: true }));
      expect(d.map((x) => x.code)).toEqual(["nodemcu.lfsRequire:fifo", "nodemcu.lfsRequire:weird_thing"]);
    });

    it("does not emit the lua_modules enable warning when LFS is on", () => {
      const d = computeLuaDiagnostics('require("ds18b20")\n', ctx({ lfsEnabled: true }));
      expect(d.every((x) => x.code.startsWith("nodemcu.lfsRequire"))).toBe(true);
    });
  });
});
