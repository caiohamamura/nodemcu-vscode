import * as fs from "node:fs/promises";
import * as path from "node:path";
import { luaModulesDir, appModulesDir, cModuleNameFromFile } from "../util/paths";

export interface LuaModuleInfo {
  name: string;
  description: string;
  mainFile: string;
  dir: string;
  examples: string[];
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
    const luaFile = files.find((f) => f.endsWith(".lua") && !f.endsWith("_Example.lua") && !f.endsWith("_Example1.lua") && !f.endsWith("_Example2.lua"));
    if (!luaFile) continue;
    const description = await extractDescription(path.join(dir, luaFile));
    const examples = files.filter((f) => /Example.*\.lua$/i.test(f));
    out.push({
      name: entry,
      description,
      mainFile: path.join(dir, luaFile),
      dir,
      examples: examples.map((e) => path.join(dir, e)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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

export interface CModuleInfo {
  name: string;
  sourceFile: string;
  category: "core" | "optional" | "library";
}

export async function listCModules(firmwarePath: string): Promise<CModuleInfo[]> {
  const out: CModuleInfo[] = [];
  const coreDir = appModulesDir(firmwarePath);
  try {
    const files = await fs.readdir(coreDir);
    for (const f of files) {
      if (f.endsWith(".c")) {
        out.push({
          name: cModuleNameFromFile(f),
          sourceFile: path.join(coreDir, f),
          category: "core",
        });
      }
    }
  } catch {
    // missing
  }
  const optionalNames = ["coap", "dht", "http", "mqtt", "pcm", "sjson", "tsl2561", "websocket"];
  for (const name of optionalNames) {
    if (await exists(path.join(firmwarePath, "app", name))) {
      out.push({ name, sourceFile: path.join(firmwarePath, "app", name), category: "optional" });
    }
  }
  for (const lib of ["u8g2", "ucg"]) {
    if (await exists(path.join(firmwarePath, "app", `${lib}lib`))) {
      out.push({ name: lib, sourceFile: path.join(firmwarePath, "app", `${lib}lib`), category: "library" });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function exists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
