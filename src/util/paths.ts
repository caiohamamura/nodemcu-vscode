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

export function cModuleNameFromFile(filename: string): string {
  return filename.replace(/\.c$/i, "").toLowerCase();
}

export function isOptionalCModule(firmwarePath: string, name: string): boolean {
  const candidate = path.join(firmwarePath, "app", name);
  return fs.existsSync(path.join(candidate, "CMakeLists.txt"));
}
