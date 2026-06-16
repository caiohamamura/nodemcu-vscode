import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateUserModulesHeader,
  writeUserModulesHeader,
  readSelectedModules,
  diffSelectedModules,
  isCModulesConfigChanged,
  isTlsEnabled,
  setUserConfigSsl,
  writeUserConfigSsl,
} from "../../src/build/userModulesWriter";
import { defaultConfig } from "../../src/config/nodemcuIni";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-vscode-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("generateUserModulesHeader", () => {
  it("includes all known modules, with selected ones #define'd and others commented", () => {
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true, mqtt: true, gpio: true };
    const header = generateUserModulesHeader(cfg);
    expect(header).toMatch(/^#define LUA_USE_MODULES_WIFI$/m);
    expect(header).toMatch(/^#define LUA_USE_MODULES_MQTT$/m);
    expect(header).toMatch(/^#define LUA_USE_MODULES_GPIO$/m);
    expect(header).toMatch(/^\/\/#define LUA_USE_MODULES_ADC$/m);
    expect(header).toMatch(/^#define LUA_USE_MODULES_FILE$/m);
  });

  it("emits guard macros", () => {
    const cfg = defaultConfig();
    const header = generateUserModulesHeader(cfg);
    expect(header).toContain("__USER_MODULES_H__");
    expect(header).toContain("#ifndef LUA_CROSS_COMPILER");
  });

  it("ignores unknown module names (no LUA_USE_MODULES_ entries for them)", () => {
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true, definitely_not_a_module: true };
    const header = generateUserModulesHeader(cfg);
    expect(header).toMatch(/^#define LUA_USE_MODULES_WIFI$/m);
    expect(header).not.toContain("LUA_USE_MODULES_DEFINITELY_NOT_A_MODULE");
  });

  it("produces stable output for the same config", () => {
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true, mqtt: true };
    const a = generateUserModulesHeader(cfg);
    const b = generateUserModulesHeader(cfg);
    expect(a).toBe(b);
  });

  it("differs when a module is added or removed", () => {
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true };
    const a = generateUserModulesHeader(cfg);
    cfg.c_modules.mqtt = true;
    const b = generateUserModulesHeader(cfg);
    expect(a).not.toBe(b);
    expect(b).toMatch(/^#define LUA_USE_MODULES_MQTT$/m);
  });

  it("force-enables http when tls is selected (tls dependency)", () => {
    const cfg = defaultConfig();
    cfg.c_modules = { tls: true };
    const header = generateUserModulesHeader(cfg);
    expect(header).toMatch(/^#define LUA_USE_MODULES_TLS$/m);
    expect(header).toMatch(/^#define LUA_USE_MODULES_HTTP$/m);
  });

  it("leaves http commented out when tls is not selected", () => {
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true };
    const header = generateUserModulesHeader(cfg);
    expect(header).toMatch(/^\/\/#define LUA_USE_MODULES_HTTP$/m);
    expect(header).toMatch(/^\/\/#define LUA_USE_MODULES_TLS$/m);
  });
});

describe("user_config.h SSL toggling for TLS", () => {
  const sample = [
    "//#define CLIENT_SSL_ENABLE",
    "#define SSL_BUFFER_SIZE 4096",
  ].join("\n") + "\n";

  it("isTlsEnabled reflects the tls c_module flag", () => {
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true };
    expect(isTlsEnabled(cfg)).toBe(false);
    cfg.c_modules.tls = true;
    expect(isTlsEnabled(cfg)).toBe(true);
  });

  it("enables CLIENT_SSL_ENABLE and bumps the buffer to the default when on", () => {
    const out = setUserConfigSsl(sample, true);
    expect(out).toMatch(/^#define CLIENT_SSL_ENABLE$/m);
    expect(out).not.toMatch(/^\/\/#define CLIENT_SSL_ENABLE$/m);
    expect(out).toMatch(/^#define SSL_BUFFER_SIZE 16384$/m);
  });

  it("honors a custom buffer size", () => {
    const out = setUserConfigSsl(sample, true, 8192);
    expect(out).toMatch(/^#define SSL_BUFFER_SIZE 8192$/m);
  });

  it("falls back to the default buffer size for invalid values", () => {
    const out = setUserConfigSsl(sample, true, 0);
    expect(out).toMatch(/^#define SSL_BUFFER_SIZE 16384$/m);
  });

  it("comments CLIENT_SSL_ENABLE back out when off and leaves the buffer", () => {
    const enabled = setUserConfigSsl(sample, true);
    const out = setUserConfigSsl(enabled, false);
    expect(out).toMatch(/^\/\/#define CLIENT_SSL_ENABLE$/m);
    // buffer is only meaningful with SSL on, so we don't churn it back down
    expect(out).toMatch(/^#define SSL_BUFFER_SIZE 16384$/m);
  });

  it("writeUserConfigSsl reports whether the file changed and is idempotent", () => {
    const headerPath = path.join(tmp, "user_config.h");
    fs.writeFileSync(headerPath, sample, "utf-8");
    expect(writeUserConfigSsl(headerPath, true)).toBe(true);
    expect(writeUserConfigSsl(headerPath, true)).toBe(false);
    const content = fs.readFileSync(headerPath, "utf-8");
    expect(content).toMatch(/^#define CLIENT_SSL_ENABLE$/m);
  });

  it("writeUserConfigSsl is a no-op when the file is missing", () => {
    expect(writeUserConfigSsl(path.join(tmp, "nope.h"), true)).toBe(false);
  });
});

describe("writeUserModulesHeader", () => {
  it("writes the file to disk and returns a diff against the previous contents", () => {
    const headerPath = path.join(tmp, "user_modules.h");
    fs.writeFileSync(headerPath, "/* empty */\n", "utf-8");
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true, mqtt: true };
    const r = writeUserModulesHeader(headerPath, cfg);
    expect(fs.existsSync(headerPath)).toBe(true);
    const content = fs.readFileSync(headerPath, "utf-8");
    expect(content).toMatch(/LUA_USE_MODULES_WIFI/);
    expect(r.written).toContain("wifi");
    expect(r.written).toContain("mqtt");
  });

  it("returns removed modules when selection shrinks", () => {
    const headerPath = path.join(tmp, "user_modules.h");
    let cfg = defaultConfig();
    cfg.c_modules = { wifi: true, mqtt: true };
    writeUserModulesHeader(headerPath, cfg);
    cfg.c_modules.mqtt = false;
    const r = writeUserModulesHeader(headerPath, cfg);
    expect(r.removed).toContain("mqtt");
  });

  it("adding a new module reports it as 'written' and leaves the rest intact", () => {
    const headerPath = path.join(tmp, "user_modules.h");
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true, node: true };
    writeUserModulesHeader(headerPath, cfg);
    cfg.c_modules.coap = true;
    const r = writeUserModulesHeader(headerPath, cfg);
    expect(r.written).toContain("coap");
    expect(r.removed).toEqual([]);
    const content = fs.readFileSync(headerPath, "utf-8");
    expect(content).toMatch(/^#define LUA_USE_MODULES_WIFI$/m);
    expect(content).toMatch(/^#define LUA_USE_MODULES_NODE$/m);
    expect(content).toMatch(/^#define LUA_USE_MODULES_COAP$/m);
  });

  it("adding an unknown module name is dropped (no entry in the header)", () => {
    const headerPath = path.join(tmp, "user_modules.h");
    const cfg = defaultConfig();
    cfg.c_modules = { wifi: true };
    writeUserModulesHeader(headerPath, cfg);
    cfg.c_modules.not_a_real_module_xyz = true;
    const r = writeUserModulesHeader(headerPath, cfg);
    expect(r.written).not.toContain("not_a_real_module_xyz");
    const content = fs.readFileSync(headerPath, "utf-8");
    expect(content).not.toMatch(/NOT_A_REAL_MODULE_XYZ/);
  });
});

describe("readSelectedModules", () => {
  it("returns lowercase module names from #define lines", () => {
    const headerPath = path.join(tmp, "user_modules.h");
    fs.writeFileSync(
      headerPath,
      `
#define LUA_USE_MODULES_WIFI
#define LUA_USE_MODULES_MQTT
//#define LUA_USE_MODULES_ADC
`,
      "utf-8",
    );
    const selected = readSelectedModules(headerPath);
    expect(selected).toContain("wifi");
    expect(selected).toContain("mqtt");
    expect(selected).not.toContain("adc");
  });

  it("returns empty array when file does not exist", () => {
    const selected = readSelectedModules(path.join(tmp, "missing.h"));
    expect(selected).toEqual([]);
  });
});

describe("diffSelectedModules", () => {
  it("detects additions and removals", () => {
    const d = diffSelectedModules(["wifi", "mqtt"], ["wifi", "adc"]);
    expect(d.added).toEqual(["adc"]);
    expect(d.removed).toEqual(["mqtt"]);
  });

  it("returns empty diffs for identical lists", () => {
    const d = diffSelectedModules(["wifi", "mqtt"], ["wifi", "mqtt"]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

describe("isCModulesConfigChanged", () => {
  it("returns true if the header file does not exist", () => {
    const headerPath = path.join(tmp, "missing.h");
    const cfg = defaultConfig();
    expect(isCModulesConfigChanged(headerPath, cfg)).toBe(true);
  });

  it("returns false if header matches current configuration, and true if they differ", () => {
    const headerPath = path.join(tmp, "user_modules.h");
    const cfg = defaultConfig();
    cfg.c_modules = { mqtt: true, coap: true };
    writeUserModulesHeader(headerPath, cfg);
    expect(isCModulesConfigChanged(headerPath, cfg)).toBe(false);

    cfg.c_modules.mqtt = false;
    expect(isCModulesConfigChanged(headerPath, cfg)).toBe(true);
  });
});
