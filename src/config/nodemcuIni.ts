import * as ini from "ini";
import * as fs from "node:fs";
import * as path from "node:path";

export interface NodemcuSection {
  firmware_path: string;
  lua_version: "51" | "53";
  lua_number_integral: boolean;
  lua_number_64bits: boolean;
  port: string;
  baud: number;
  upload_baud: number;
  flash_mode: "dio" | "qio" | "dout" | "qout";
  flash_freq: "40m" | "26m" | "20m" | "80m";
  flash_size: string;
  parallel: boolean;
  verbose: boolean;
  src: string;
}

export interface LuaModuleEntry {
  name: string;
  source: string;
  isRemote: boolean;
}

export interface FlashExtraFile {
  path: string;
  offset: string;
}

export interface NodemcuConfig {
  nodemcu: NodemcuSection;
  c_modules: Record<string, boolean>;
  lua_modules: Record<string, string>;
  flash: { extra_files: FlashExtraFile[] };
  build: { parallel: boolean; verbose: boolean };
}

const DEFAULT_NODEMCU: NodemcuSection = {
  firmware_path: "",
  lua_version: "53",
  lua_number_integral: false,
  lua_number_64bits: false,
  port: "",
  baud: 115200,
  upload_baud: 115200,
  flash_mode: "dio",
  flash_freq: "40m",
  flash_size: "1M",
  parallel: true,
  verbose: false,
  src: "src",
};

export function defaultConfig(): NodemcuConfig {
  return {
    nodemcu: { ...DEFAULT_NODEMCU },
    c_modules: {},
    lua_modules: {},
    flash: { extra_files: [] },
    build: { parallel: true, verbose: false },
  };
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "on" || s === "1") return true;
  if (s === "false" || s === "no" || s === "off" || s === "0") return false;
  return fallback;
}

function coerceNumber(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function coerceString(v: unknown, fallback: string): string {
  if (v === undefined || v === null) return fallback;
  return String(v);
}

function parseExtraFiles(value: string): FlashExtraFile[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [filePath, offset] = entry.split("@").map((s) => s.trim());
      return { path: filePath, offset: offset ?? "0" };
    });
}

export function parseIni(content: string): NodemcuConfig {
  const raw = ini.parse(content);
  const n = (raw.nodemcu ?? {}) as Record<string, unknown>;
  const c = (raw.c_modules ?? {}) as Record<string, unknown>;
  const l = (raw.lua_modules ?? {}) as Record<string, unknown>;
  const f = (raw.flash ?? {}) as Record<string, unknown>;
  const b = (raw.build ?? {}) as Record<string, unknown>;

  const config = defaultConfig();

  config.nodemcu.firmware_path = coerceString(n.firmware_path, DEFAULT_NODEMCU.firmware_path);
  const luaVer = coerceString(n.lua_version, DEFAULT_NODEMCU.lua_version);
  config.nodemcu.lua_version = luaVer === "51" || luaVer === "53" ? luaVer : "53";
  config.nodemcu.lua_number_integral = coerceBool(n.lua_number_integral, DEFAULT_NODEMCU.lua_number_integral);
  config.nodemcu.lua_number_64bits = coerceBool(n.lua_number_64bits, DEFAULT_NODEMCU.lua_number_64bits);
  config.nodemcu.port = coerceString(n.port, DEFAULT_NODEMCU.port);
  config.nodemcu.baud = coerceNumber(n.baud, DEFAULT_NODEMCU.baud);
  config.nodemcu.upload_baud = coerceNumber(n.upload_baud, DEFAULT_NODEMCU.upload_baud);
  const fm = coerceString(n.flash_mode, DEFAULT_NODEMCU.flash_mode);
  config.nodemcu.flash_mode = ["dio", "qio", "dout", "qout"].includes(fm)
    ? (fm as NodemcuSection["flash_mode"])
    : DEFAULT_NODEMCU.flash_mode;
  const ff = coerceString(n.flash_freq, DEFAULT_NODEMCU.flash_freq);
  config.nodemcu.flash_freq = ["40m", "26m", "20m", "80m"].includes(ff)
    ? (ff as NodemcuSection["flash_freq"])
    : DEFAULT_NODEMCU.flash_freq;
  config.nodemcu.flash_size = coerceString(n.flash_size, DEFAULT_NODEMCU.flash_size);
  config.nodemcu.parallel = coerceBool(n.parallel, DEFAULT_NODEMCU.parallel);
  config.nodemcu.verbose = coerceBool(n.verbose, DEFAULT_NODEMCU.verbose);
  config.nodemcu.src = coerceString(n.src, DEFAULT_NODEMCU.src);

  for (const [key, value] of Object.entries(c)) {
    config.c_modules[key.toLowerCase()] = coerceBool(value, true);
  }

  for (const [key, value] of Object.entries(l)) {
    const source = coerceString(value, "");
    if (source) {
      config.lua_modules[key] = source;
    }
  }

  config.flash.extra_files = parseExtraFiles(coerceString(f.extra_files, ""));

  config.build.parallel = coerceBool(b.parallel, config.nodemcu.parallel);
  config.build.verbose = coerceBool(b.verbose, config.nodemcu.verbose);

  return config;
}

export function serializeIni(config: NodemcuConfig): string {
  const out: Record<string, Record<string, string | number | boolean>> = {};
  out.nodemcu = {
    firmware_path: config.nodemcu.firmware_path,
    lua_version: config.nodemcu.lua_version,
    lua_number_integral: config.nodemcu.lua_number_integral,
    lua_number_64bits: config.nodemcu.lua_number_64bits,
    port: config.nodemcu.port,
    baud: config.nodemcu.baud,
    upload_baud: config.nodemcu.upload_baud,
    flash_mode: config.nodemcu.flash_mode,
    flash_freq: config.nodemcu.flash_freq,
    flash_size: config.nodemcu.flash_size,
    parallel: config.nodemcu.parallel,
    verbose: config.nodemcu.verbose,
    src: config.nodemcu.src,
  };
  out.c_modules = {};
  for (const [k, v] of Object.entries(config.c_modules)) {
    out.c_modules[k] = v;
  }
  out.lua_modules = {};
  for (const [k, v] of Object.entries(config.lua_modules)) {
    out.lua_modules[k] = v;
  }
  out.flash = {
    extra_files: config.flash.extra_files.map((f) => `${f.path}@${f.offset}`).join(", "),
  };
  out.build = {
    parallel: config.build.parallel,
    verbose: config.build.verbose,
  };
  return ini.stringify(out);
}

export function loadConfig(iniPath: string): NodemcuConfig {
  if (!fs.existsSync(iniPath)) {
    throw new Error(`nodemcu.ini not found: ${iniPath}`);
  }
  const content = fs.readFileSync(iniPath, "utf-8");
  return parseIni(content);
}

export function saveConfig(iniPath: string, config: NodemcuConfig): void {
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  fs.writeFileSync(iniPath, serializeIni(config), "utf-8");
}

export function setCModule(config: NodemcuConfig, name: string, enabled: boolean): NodemcuConfig {
  return {
    ...config,
    c_modules: { ...config.c_modules, [name.toLowerCase()]: enabled },
  };
}

export function setLuaModule(config: NodemcuConfig, name: string, source: string): NodemcuConfig {
  return {
    ...config,
    lua_modules: { ...config.lua_modules, [name]: source },
  };
}

export function getLuaModuleEntries(config: NodemcuConfig): LuaModuleEntry[] {
  return Object.entries(config.lua_modules).map(([name, source]) => ({
    name,
    source,
    isRemote: /^https?:\/\//i.test(source),
  }));
}
