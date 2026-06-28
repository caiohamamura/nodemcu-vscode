import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listLuaModulesFromFirmware } from "../luaPicker/moduleList";
import { appModulesDir } from "../util/paths";

export interface MappedFunction {
  luaName: string;
  cName?: string;
  description: string;
}

export interface MappedConstant {
  luaName: string;
  value: string;
  type: "number" | "integer";
}

export interface MappedModule {
  name: string;
  type: "C" | "Lua";
  description: string;
  functions: MappedFunction[];
  constants: MappedConstant[];
  subtables: Record<string, MappedSubtable>;
}

export interface MappedSubtable {
  name: string;
  functions: MappedFunction[];
  constants: MappedConstant[];
  subtables: Record<string, MappedSubtable>;
}

interface ROTable {
  name: string;
  entries: {
    type: "function" | "number" | "integer" | "table";
    luaName: string;
    target?: string; // cName or submap
  }[];
}

async function getSourceFiles(srcPath: string): Promise<string[]> {
  const stat = await fs.stat(srcPath).catch(() => null);
  if (!stat) return [];
  if (stat.isFile()) {
    return [srcPath];
  }
  const files: string[] = [];
  const entries = await fs.readdir(srcPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(srcPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getSourceFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".c")) {
      files.push(full);
    }
  }
  return files;
}

async function extractCFunctionComment(cFilesContent: { path: string; content: string }[], cName: string): Promise<string> {
  const funcDefRegex = new RegExp(`(?:static\\s+)?(?:int|void|char\\*|const\\s+char\\*)\\s+${cName}\\s*\\(`, "m");
  for (const file of cFilesContent) {
    const match = file.content.match(funcDefRegex);
    if (!match || match.index === undefined) continue;

    const index = match.index;
    const beforeContent = file.content.substring(0, index);
    const lines = beforeContent.split("\n");

    const commentLines: string[] = [];
    let inMultiLine = false;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "") {
        if (commentLines.length > 0) break;
        continue;
      }

      if (line.endsWith("*/")) {
        inMultiLine = true;
        const cleaned = line.replace(/\*\/$/, "").trim();
        commentLines.unshift(cleaned);
        if (line.startsWith("/*")) {
          inMultiLine = false;
          commentLines[0] = commentLines[0].replace(/^\/\*/, "").trim();
          break;
        }
        continue;
      }

      if (inMultiLine) {
        let cleaned = line.replace(/^\s*\*\s?/, "").trim();
        if (line.startsWith("/*")) {
          inMultiLine = false;
          cleaned = cleaned.replace(/^\/\*/, "").trim();
          commentLines.unshift(cleaned);
          break;
        }
        commentLines.unshift(cleaned);
        continue;
      }

      if (line.startsWith("//")) {
        const cleaned = line.substring(2).trim();
        commentLines.unshift(cleaned);
      } else {
        break;
      }
    }

    const doc = commentLines.filter((l) => l.length > 0).join(" ");
    if (doc) return doc;
  }
  return "";
}

export async function mapFirmwareAPI(firmwarePath: string): Promise<MappedModule[]> {
  const mappedModules: MappedModule[] = [];

  // 1. Process C Modules
  const cModules: { name: string; sourceFile: string; category: string }[] = [];
  const coreDir = appModulesDir(firmwarePath);
  const coreFiles = await fs.readdir(coreDir).catch(() => []);
  for (const f of coreFiles) {
    if (f.endsWith(".c")) {
      const modName = path.basename(f, ".c").toLowerCase();
      cModules.push({
        name: modName,
        sourceFile: path.join(coreDir, f),
        category: "core",
      });
    }
  }

  const optionalNames = ["coap", "dht", "http", "mqtt", "pcm", "sjson", "tsl2561", "websocket"];
  for (const name of optionalNames) {
    const p = path.join(firmwarePath, "app", name);
    const s = await fs.stat(p).catch(() => null);
    if (s?.isDirectory()) {
      cModules.push({ name, sourceFile: p, category: "optional" });
    }
  }

  for (const lib of ["u8g2", "ucg"]) {
    const p = path.join(firmwarePath, "app", `${lib}lib`);
    const s = await fs.stat(p).catch(() => null);
    if (s?.isDirectory()) {
      cModules.push({ name: lib, sourceFile: p, category: "library" });
    }
  }

  for (const mod of cModules) {
    const cFiles = await getSourceFiles(mod.sourceFile);
    const filesContent: { path: string; content: string }[] = [];
    for (const f of cFiles) {
      const content = await fs.readFile(f, "utf-8").catch(() => "");
      filesContent.push({ path: f, content });
    }

    // Extract all ROTables and mappings defined in C files
    const rotables: Record<string, ROTable> = {};
    const moduleRegistrations: { modName: string; rootMap: string }[] = [];

    for (const file of filesContent) {
      // Find LROT blocks
      const lrotBlockRegex = /LROT_BEGIN\s*\(\s*([a-zA-Z0-9_]+)\s*\)([\s\S]*?)LROT_END/g;
      let match;
      while ((match = lrotBlockRegex.exec(file.content)) !== null) {
        const mapName = match[1];
        const body = match[2];
        const entries: ROTable["entries"] = [];

        // Parse entries in LROT
        const entryRegex = /(LROT_FUNCENTRY|LROT_NUMENTRY|LROT_INTENTRY|LROT_TABENTRY)\s*\(\s*([a-zA-Z0-9_]+)\s*,\s*([^)]+)\)/g;
        let entryMatch;
        while ((entryMatch = entryRegex.exec(body)) !== null) {
          const typeStr = entryMatch[1];
          const luaName = entryMatch[2];
          const val = entryMatch[3].trim();

          if (typeStr === "LROT_FUNCENTRY") {
            entries.push({ type: "function", luaName, target: val });
          } else if (typeStr === "LROT_NUMENTRY") {
            entries.push({ type: "number", luaName, target: val });
          } else if (typeStr === "LROT_INTENTRY") {
            entries.push({ type: "integer", luaName, target: val });
          } else if (typeStr === "LROT_TABENTRY") {
            entries.push({ type: "table", luaName, target: val });
          }
        }
        rotables[mapName] = { name: mapName, entries };
      }

      // Find LUA_REG_TYPE maps
      const regTypeRegex = /(?:const\s+)?LUA_REG_TYPE\s+([a-zA-Z0-9_]+)\s*\[\s*\]\s*=\s*\{([\s\S]*?)\};/g;
      while ((match = regTypeRegex.exec(file.content)) !== null) {
        const mapName = match[1];
        const body = match[2];
        const entries: ROTable["entries"] = [];

        const funcRegex = /\{\s*LSTRKEY\s*\(\s*"([a-zA-Z0-9_]+)"\s*\)\s*,\s*LFUNCVAL\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g;
        let itemMatch;
        while ((itemMatch = funcRegex.exec(body)) !== null) {
          entries.push({ type: "function", luaName: itemMatch[1], target: itemMatch[2] });
        }

        const numRegex = /\{\s*LSTRKEY\s*\(\s*"([a-zA-Z0-9_]+)"\s*\)\s*,\s*(LNVAL|LNUMVAL)\s*\(\s*([^)]+)\s*\)\s*\}/g;
        while ((itemMatch = numRegex.exec(body)) !== null) {
          entries.push({ type: "number", luaName: itemMatch[1], target: itemMatch[3].trim() });
        }

        const tabRegex = /\{\s*LSTRKEY\s*\(\s*"([a-zA-Z0-9_]+)"\s*\)\s*,\s*LROVAL\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g;
        while ((itemMatch = tabRegex.exec(body)) !== null) {
          entries.push({ type: "table", luaName: itemMatch[1], target: itemMatch[2].trim() });
        }

        rotables[mapName] = { name: mapName, entries };
      }

      // Find NODEMCU_MODULE registrations
      const nodemcuModuleRegex = /NODEMCU_MODULE\s*\(\s*([a-zA-Z0-9_]+)\s*,\s*"([a-zA-Z0-9_]+)"\s*,\s*([a-zA-Z0-9_]+)\s*,\s*([a-zA-Z0-9_]+)\s*\)/g;
      while ((match = nodemcuModuleRegex.exec(file.content)) !== null) {
        moduleRegistrations.push({ modName: match[2], rootMap: match[3] });
      }
    }

    // Determine root map
    let rootMapName = "";
    const reg = moduleRegistrations.find((r) => r.modName.toLowerCase() === mod.name.toLowerCase());
    if (reg) {
      rootMapName = reg.rootMap;
    } else {
      // Find best match in keys
      const keys = Object.keys(rotables);
      const exact = keys.find((k) => k.toLowerCase() === mod.name.toLowerCase() || k.toLowerCase() === `${mod.name}_map`);
      if (exact) {
        rootMapName = exact;
      } else if (keys.length > 0) {
        rootMapName = keys[0];
      }
    }

    const functions: MappedFunction[] = [];
    const constants: MappedConstant[] = [];
    const subtables: Record<string, MappedSubtable> = {};

    const resolveSubtable = async (tableName: string, mapName: string): Promise<MappedSubtable> => {
      const subFuncs: MappedFunction[] = [];
      const subConsts: MappedConstant[] = [];
      const subTabs: Record<string, MappedSubtable> = {};

      const tableData = rotables[mapName];
      if (tableData) {
        for (const entry of tableData.entries) {
          if (entry.type === "function" && entry.target) {
            const desc = await extractCFunctionComment(filesContent, entry.target);
            subFuncs.push({ luaName: entry.luaName, cName: entry.target, description: desc });
          } else if ((entry.type === "number" || entry.type === "integer") && entry.target) {
            subConsts.push({ luaName: entry.luaName, value: entry.target, type: entry.type });
          } else if (entry.type === "table" && entry.target) {
            const childTable = await resolveSubtable(entry.luaName, entry.target);
            subTabs[entry.luaName] = childTable;
          }
        }
      }

      return { name: tableName, functions: subFuncs, constants: subConsts, subtables: subTabs };
    };

    const rootTableData = rotables[rootMapName];
    if (rootTableData) {
      for (const entry of rootTableData.entries) {
        if (entry.type === "function" && entry.target) {
          const desc = await extractCFunctionComment(filesContent, entry.target);
          functions.push({ luaName: entry.luaName, cName: entry.target, description: desc });
        } else if ((entry.type === "number" || entry.type === "integer") && entry.target) {
          constants.push({ luaName: entry.luaName, value: entry.target, type: entry.type });
        } else if (entry.type === "table" && entry.target) {
          const sub = await resolveSubtable(entry.luaName, entry.target);
          subtables[entry.luaName] = sub;
        }
      }
    }

    mappedModules.push({
      name: mod.name,
      type: "C",
      description: `${mod.name} firmware module`,
      functions,
      constants,
      subtables,
    });
  }

  // 2. Process Lua Modules
  const luaModules = await listLuaModulesFromFirmware(firmwarePath);
  for (const mod of luaModules) {
    const content = await fs.readFile(mod.mainFile, "utf-8").catch(() => "");
    const functions: MappedFunction[] = [];
    const constants: MappedConstant[] = [];

    // Parse Lua functions
    const funcRegex = /function\s+(?:[a-zA-Z0-9_]+)[:.]([a-zA-Z0-9_]+)\s*\(([^)]*)\)/g;
    let match;
    while ((match = funcRegex.exec(content)) !== null) {
      const name = match[1];
      const params = match[2];
      functions.push({
        luaName: name,
        description: `Function ${name}(${params})`,
      });
    }

    // Parse simple variable assignments
    const varRegex = /(?:local\s+)?M\.([a-zA-Z0-9_]+)\s*=\s*(function\s*\(([^)]*)\)|[^M\n]+)/g;
    while ((match = varRegex.exec(content)) !== null) {
      const name = match[1];
      const val = match[2].trim();
      if (val.startsWith("function")) {
        const paramsMatch = val.match(/function\s*\(([^)]*)\)/);
        const params = paramsMatch ? paramsMatch[1] : "";
        if (!functions.some((f) => f.luaName === name)) {
          functions.push({
            luaName: name,
            description: `Function ${name}(${params})`,
          });
        }
      } else {
        if (!constants.some((c) => c.luaName === name)) {
          constants.push({
            luaName: name,
            value: val,
            type: "number",
          });
        }
      }
    }

    mappedModules.push({
      name: mod.name,
      type: "Lua",
      description: mod.description || `${mod.name} library module`,
      functions,
      constants,
      subtables: {},
    });
  }

  return mappedModules;
}

export function generateEmmyLuaStub(modules: MappedModule[]): string {
  const lines: string[] = [];
  lines.push("---@meta");
  lines.push("--- Auto-generated by NodeMCU developer tool mapper. Do not edit by hand.");
  lines.push("---@diagnostic disable");
  lines.push("");

  const formatSubtableClass = (parentPath: string, sub: MappedSubtable) => {
    const className = `${parentPath}_${sub.name}`;
    lines.push(`---@class ${className}`);
    for (const f of sub.functions) {
      const desc = f.description ? ` ${f.description}` : "";
      lines.push(`---@field ${f.luaName} fun(...)${desc}`);
    }
    for (const c of sub.constants) {
      lines.push(`---@field ${c.luaName} ${c.type}`);
    }
    for (const s of Object.values(sub.subtables)) {
      lines.push(`---@field ${s.name} ${className}_${s.name}`);
    }
    lines.push("");

    for (const s of Object.values(sub.subtables)) {
      formatSubtableClass(className, s);
    }
  };

  for (const mod of modules) {
    const modClass = mod.name;
    lines.push(`---@class ${modClass}`);
    for (const f of mod.functions) {
      const desc = f.description ? ` ${f.description}` : "";
      lines.push(`---@field ${f.luaName} fun(...)${desc}`);
    }
    for (const c of mod.constants) {
      lines.push(`---@field ${c.luaName} ${c.type}`);
    }
    for (const s of Object.values(mod.subtables)) {
      lines.push(`---@field ${s.name} ${modClass}_${s.name}`);
    }
    lines.push("");

    for (const s of Object.values(mod.subtables)) {
      formatSubtableClass(modClass, s);
    }

    lines.push(`${mod.name} = ${mod.name} or {}`);
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

export function generateMarkdownReport(modules: MappedModule[]): string {
  const lines: string[] = [];
  lines.push("# NodeMCU Firmware API Map");
  lines.push("");
  lines.push("This document registers all objects, tables, functions, and constants mapped directly from the active firmware C Modules and Lua Modules.");
  lines.push("");

  const renderSubtable = (sub: MappedSubtable, depth: number) => {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- **Table: ${sub.name}**`);
    for (const f of sub.functions) {
      const desc = f.description ? ` - *${f.description}*` : "";
      lines.push(`${indent}  - Function \`${f.luaName}()\`${desc}`);
    }
    for (const c of sub.constants) {
      lines.push(`${indent}  - Constant \`${c.luaName}\` = \`${c.value}\``);
    }
    for (const s of Object.values(sub.subtables)) {
      renderSubtable(s, depth + 1);
    }
  };

  for (const mod of modules) {
    lines.push(`## ${mod.name} (${mod.type} Module)`);
    lines.push(`*${mod.description}*`);
    lines.push("");

    if (mod.functions.length > 0) {
      lines.push("### Functions");
      for (const f of mod.functions) {
        const desc = f.description ? ` - *${f.description}*` : "";
        lines.push(`- \`${mod.name}.${f.luaName}()\`${desc}`);
      }
      lines.push("");
    }

    if (mod.constants.length > 0) {
      lines.push("### Constants");
      for (const c of mod.constants) {
        lines.push(`- \`${mod.name}.${c.luaName}\` = \`${c.value}\``);
      }
      lines.push("");
    }

    if (Object.keys(mod.subtables).length > 0) {
      lines.push("### Sub-tables");
      for (const s of Object.values(mod.subtables)) {
        renderSubtable(s, 0);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
