import * as path from "node:path";
import * as fs from "node:fs";

export function resolveFirmwarePath(workspaceRoot: string, configured: string): string {
  if (!configured) {
    throw new Error("firmwarePath is not configured. Set nodemcu-vscode.firmwarePath in settings or [nodemcu] firmware_path in nodemcu.ini.");
  }
  const resolved = path.isAbsolute(configured)
    ? configured
    : path.resolve(workspaceRoot, configured);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Firmware path does not exist: ${resolved}`);
  }
  if (!fs.existsSync(path.join(resolved, "CMakeLists.txt"))) {
    throw new Error(`Firmware path is missing CMakeLists.txt: ${resolved}`);
  }
  return resolved;
}

export function defaultBuildDir(firmwarePath: string): string {
  return path.join(firmwarePath, "build");
}

export function userModulesHeader(firmwarePath: string): string {
  return path.join(firmwarePath, "app", "include", "user_modules.h");
}

export function userConfigHeader(firmwarePath: string): string {
  return path.join(firmwarePath, "app", "include", "user_config.h");
}

export function esptoolScript(firmwarePath: string): string {
  return path.join(firmwarePath, "tools", "toolchains", "esptool.py");
}

export function luaModulesDir(firmwarePath: string): string {
  return path.join(firmwarePath, "lua_modules");
}

export function appModulesDir(firmwarePath: string): string {
  return path.join(firmwarePath, "app", "modules");
}

export function binOutput(firmwarePath: string): string {
  return path.join(firmwarePath, "bin");
}

/**
 * Path to the `luac.cross` host tool produced by the firmware build when a host
 * C compiler was detected at configure time (BUILD_HOST_TOOLS). Lives in the
 * outer build dir, not the firmware ExternalProject.
 */
export function luacCrossPath(firmwarePath: string): string {
  const exe = process.platform === "win32" ? "luac.cross.exe" : "luac.cross";
  return path.join(defaultBuildDir(firmwarePath), "tools", "luac_cross", exe);
}

/**
 * Cache directory for a pre-built `luac.cross` binary downloaded on demand.
 * Keyed by Lua version so lua51 and lua53 don't clobber each other.
 * `<storageRoot>/luac_cross/<luaVersion>/`
 */
export function prebuiltLuacCrossDir(storageRoot: string, luaVersion: string): string {
  return path.join(storageRoot, "luac_cross", luaVersion);
}

/** Path to the cached pre-built `luac.cross` binary. */
export function prebuiltLuacCrossPath(storageRoot: string, luaVersion: string): string {
  const exe = process.platform === "win32" ? "luac.cross.exe" : "luac.cross";
  return path.join(prebuiltLuacCrossDir(storageRoot, luaVersion), exe);
}

/** Output path for the generated LFS image (uploaded to the device + flashreload'd). */
export function lfsImagePath(firmwarePath: string): string {
  return path.join(defaultBuildDir(firmwarePath), "lfs.img");
}

export function cModuleNameFromFile(filename: string): string {
  return filename.replace(/\.c$/i, "").toLowerCase();
}

export function isOptionalCModule(firmwarePath: string, name: string): boolean {
  const candidate = path.join(firmwarePath, "app", name);
  return fs.existsSync(path.join(candidate, "CMakeLists.txt"));
}

/**
 * Bin directories of the bundled cross toolchain(s) under
 * `<firmwarePath>/tools/toolchains/`. The firmware downloads e.g.
 * `esp8266-xtensa-lx106-elf-win32-.../` with both a top-level `bin/`
 * (prefixed tools like `xtensa-lx106-elf-as`) and a `<target>/bin/` (bare
 * `as`, `ld`, ... which gcc spawns by short name). These must be on PATH for
 * the compile, otherwise gcc fails with "CreateProcess: No such file or
 * directory" when it cannot launch its assembler. Returns existing dirs only;
 * empty before the toolchain has been fetched.
 */
export function toolchainBinDirs(firmwarePath: string): string[] {
  const root = path.join(firmwarePath, "tools", "toolchains");
  const dirs: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    const base = path.join(root, entry);
    try {
      if (!fs.statSync(base).isDirectory()) continue;
    } catch {
      continue;
    }
    const topBin = path.join(base, "bin");
    if (fs.existsSync(topBin)) dirs.push(topBin);
    // The bare-named assembler/linker live one level deeper in <target>/bin.
    let sub: string[] = [];
    try {
      sub = fs.readdirSync(base);
    } catch {
      sub = [];
    }
    for (const s of sub) {
      const subBin = path.join(base, s, "bin");
      if (subBin !== topBin && fs.existsSync(subBin)) dirs.push(subBin);
    }
  }
  return dirs;
}
