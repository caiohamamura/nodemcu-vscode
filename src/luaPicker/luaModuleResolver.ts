import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLuaModuleEntries, type NodemcuConfig, type LuaModuleEntry } from "../config/nodemcuIni";
import { luaModulesDir } from "../util/paths";

export interface ResolvedLuaModule extends LuaModuleEntry {
  resolvedLocalPath: string | null;
  exists: boolean;
  size: number;
}

export async function resolveLuaModule(
  workspaceRoot: string,
  firmwarePath: string,
  entry: LuaModuleEntry,
): Promise<ResolvedLuaModule> {
  if (entry.isRemote) {
    return { ...entry, resolvedLocalPath: null, exists: false, size: 0 };
  }
  const candidates: string[] = [];
  if (path.isAbsolute(entry.source)) {
    candidates.push(entry.source);
  } else {
    candidates.push(path.resolve(workspaceRoot, entry.source));
    const fwLua = luaModulesDir(firmwarePath);
    candidates.push(path.join(fwLua, entry.name, path.basename(entry.source)));
    candidates.push(path.join(fwLua, entry.source));
  }
  for (const c of candidates) {
    try {
      const s = await fs.stat(c);
      if (s.isFile()) {
        return { ...entry, resolvedLocalPath: c, exists: true, size: s.size };
      }
    } catch {
      // try next
    }
  }
  return { ...entry, resolvedLocalPath: candidates[0] ?? null, exists: false, size: 0 };
}

export async function resolveAllLuaModules(
  workspaceRoot: string,
  firmwarePath: string,
  config: NodemcuConfig,
): Promise<ResolvedLuaModule[]> {
  const entries = getLuaModuleEntries(config);
  return await Promise.all(entries.map((e) => resolveLuaModule(workspaceRoot, firmwarePath, e)));
}

export function validateLuaModuleSource(source: string): { ok: true } | { ok: false; reason: string } {
  if (!source) return { ok: false, reason: "empty path" };
  if (/^https?:\/\//i.test(source)) {
    try {
      new URL(source);
      return { ok: true };
    } catch {
      return { ok: false, reason: "invalid URL" };
    }
  }
  if (source.includes("..")) return { ok: false, reason: "path traversal not allowed" };
  return { ok: true };
}
