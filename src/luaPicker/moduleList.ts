import * as fs from "node:fs/promises";
import * as path from "node:path";
import { luaModulesDir, appModulesDir, cModuleNameFromFile } from "../util/paths";

export interface LuaModuleInfo {
  name: string;
  description: string;
  mainFile: string;
  dir: string;
  examples: string[];
  allFiles: string[];
}

export async function listLuaModulesFromFirmware(firmwarePath: string): Promise<LuaModuleInfo[]> {
  const root = luaModulesDir(firmwarePath);
  return await listLuaModulesFromDir(root);
}

export async function listLuaModulesFromDir(root: string): Promise<LuaModuleInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: LuaModuleInfo[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const files = await fs.readdir(dir).catch(() => []);
    const luaFiles = files.filter((f) => f.endsWith(".lua"));
    if (luaFiles.length === 0) continue;
    const mainFile = selectMainFile(entry, luaFiles);
    if (!mainFile) continue;
    const description = await extractDescription(path.join(dir, mainFile));
    const examples = luaFiles.filter((f) => isNonMainFile(f, entry));
    out.push({
      name: entry,
      description,
      mainFile: path.join(dir, mainFile),
      dir,
      examples: examples.map((e) => path.join(dir, e)),
      allFiles: luaFiles.map((f) => path.join(dir, f)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function selectMainFile(dirName: string, luaFiles: string[]): string | null {
  const dirLower = dirName.toLowerCase();
  const exactMatch = luaFiles.find((f) => path.basename(f, ".lua").toLowerCase() === dirLower);
  if (exactMatch) return exactMatch;
  const candidates = luaFiles.filter((f) => !isNonMainFile(f, dirName));
  if (candidates.length > 0) return candidates[0];
  return luaFiles[0];
}

function isNonMainFile(fileName: string, dirName: string): boolean {
  const base = path.basename(fileName, ".lua").toLowerCase();
  const dirLower = dirName.toLowerCase();
  if (base === dirLower) return false;
  if (/example/i.test(fileName)) return true;
  if (/_test/i.test(fileName) || /test_/i.test(fileName)) return true;
  if (/-web$/i.test(base)) return true;
  if (/-integer$/i.test(base)) return true;
  if (/^example[_-]/i.test(fileName)) return true;
  if (/_example\d*$/i.test(fileName)) return true;
  return false;
}

export function selectMainFileForConfig(module: LuaModuleInfo, config?: { lua_number_integral?: boolean }): string {
  if (config?.lua_number_integral) {
    const integerBasename = `${module.name}-integer.lua`;
    const integerVariant = module.allFiles.find((f) => path.basename(f).toLowerCase() === integerBasename.toLowerCase());
    if (integerVariant) {
      return integerVariant;
    }
  }
  return module.mainFile;
}

async function extractDescription(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const firstComment = content.match(/^--\s*(.+)$/m);
    return firstComment ? firstComment[1].trim() : "";
  } catch {
    return "";
  }
}

import { MANDATORY_C_MODULES } from "../build/userModulesWriter";

export interface CModuleInfo {
  name: string;
  sourceFile: string;
  category: "core" | "optional" | "library";
}

export async function listCModules(firmwarePath: string): Promise<CModuleInfo[]> {
  const logFile = path.join(path.dirname(path.dirname(firmwarePath)), "c_modules_debug.log");
  const log = (msg: string) => {
    try {
      require("node:fs").appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
    } catch {}
  };

  log(`listCModules called with firmwarePath: ${firmwarePath}`);
  const out: CModuleInfo[] = [];
  const coreDir = appModulesDir(firmwarePath);
  log(`appModulesDir: ${coreDir}`);
  try {
    const files = await fs.readdir(coreDir);
    log(`readdir found ${files.length} files`);
    for (const f of files) {
      if (f.endsWith(".c")) {
        const modName = cModuleNameFromFile(f);
        if (!MANDATORY_C_MODULES.has(modName)) {
          out.push({
            name: modName,
            sourceFile: path.join(coreDir, f),
            category: "core",
          });
        }
      }
    }
  } catch (err) {
    log(`Error reading coreDir: ${err instanceof Error ? err.stack : String(err)}`);
  }
  const optionalNames = ["coap", "dht", "http", "mqtt", "pcm", "sjson", "tsl2561", "websocket"];
  for (const name of optionalNames) {
    try {
      if (await exists(path.join(firmwarePath, "app", name))) {
        out.push({ name, sourceFile: path.join(firmwarePath, "app", name), category: "optional" });
      }
    } catch (err) {
      log(`Error checking optional ${name}: ${err}`);
    }
  }
  for (const lib of ["u8g2", "ucg"]) {
    try {
      if (await exists(path.join(firmwarePath, "app", `${lib}lib`))) {
        out.push({ name: lib, sourceFile: path.join(firmwarePath, "app", `${lib}lib`), category: "library" });
      }
    } catch (err) {
      log(`Error checking library ${lib}: ${err}`);
    }
  }
  log(`Returning ${out.length} modules before filtering mandatory`);
  const filteredOut = out.filter(m => !MANDATORY_C_MODULES.has(m.name)).sort((a, b) => a.name.localeCompare(b.name));
  log(`Returning ${filteredOut.length} modules after filtering mandatory`);
  return filteredOut;
}

async function exists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
