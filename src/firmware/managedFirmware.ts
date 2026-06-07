import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import extract from "extract-zip";

export const MANAGED_FIRMWARE_TAG = "mbedtls-2.28.10-beta";
export const MANAGED_FIRMWARE_URL = `https://github.com/caiohamamura/nodemcu-firmware/archive/refs/tags/${MANAGED_FIRMWARE_TAG}.zip`;

const MARKER_FILE = ".nodemcu-vscode-managed-firmware.json";
const NEWLIB_COMPAT_SOURCE = path.join("app", "nodemcu-vscode-newlib.c");
const LUAC_ASSERT_COMPAT_SOURCE = path.join("tools", "luac_cross", "nodemcu-vscode-luac-assert.c");

const SUBMODULES = [
  {
    path: path.join("app", "libc", "c99-snprintf"),
    url: "https://github.com/weiss/c99-snprintf/archive/refs/heads/master.zip",
    requiredFile: "snprintf.c",
  },
  {
    path: path.join("app", "u8g2lib", "u8g2"),
    url: "https://github.com/olikraus/U8g2_Arduino/archive/refs/heads/master.zip",
    requiredFile: path.join("src", "clib", "u8g2.h"),
  },
  {
    path: path.join("app", "ucglib", "ucg"),
    url: "https://github.com/olikraus/Ucglib_Arduino/archive/refs/heads/master.zip",
    requiredFile: path.join("src", "clib", "ucg.h"),
  },
];

export interface EnsureManagedFirmwareOptions {
  storageRoot: string;
  onProgress?: (message: string) => void;
}

export async function ensureManagedFirmware(opts: EnsureManagedFirmwareOptions): Promise<string> {
  const root = path.join(opts.storageRoot, "firmware", MANAGED_FIRMWARE_TAG);
  const markerPath = path.join(root, MARKER_FILE);
  if (isManagedFirmwareReady(root)) return root;
  if (isUsableExtractedFirmwareRoot(root)) {
    opts.onProgress?.("Finalizing managed firmware");
    await applyCompatibilityPatches(root);
    await writeMarker(markerPath);
    return root;
  }

  opts.onProgress?.("Preparing firmware storage");
  await fsp.mkdir(path.dirname(root), { recursive: true });
  await fsp.rm(root, { recursive: true, force: true });

  const tempRoot = path.join(opts.storageRoot, "firmware", `.download-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);
  const zipPath = path.join(tempRoot, `${MANAGED_FIRMWARE_TAG}.zip`);
  const extractRoot = path.join(tempRoot, "extract");
  await fsp.mkdir(extractRoot, { recursive: true });

  try {
    opts.onProgress?.("Downloading NodeMCU firmware");
    await downloadFile(MANAGED_FIRMWARE_URL, zipPath);

    opts.onProgress?.("Extracting NodeMCU firmware");
    await extract(zipPath, { dir: extractRoot });

    const extractedRoot = await findFirmwareRoot(extractRoot);
    if (!extractedRoot) {
      throw new Error("Downloaded archive does not contain a NodeMCU firmware root.");
    }

    await fsp.mkdir(path.dirname(root), { recursive: true });
    await fsp.rename(extractedRoot, root).catch(async () => {
      await copyDirectory(extractedRoot, root);
      await fsp.rm(extractedRoot, { recursive: true, force: true });
    });

    await hydrateSubmodules(root, tempRoot, opts.onProgress);
    await applyCompatibilityPatches(root);

    await writeMarker(markerPath);
    return root;
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeMarker(markerPath: string): Promise<void> {
  await fsp.writeFile(markerPath, JSON.stringify({ tag: MANAGED_FIRMWARE_TAG, url: MANAGED_FIRMWARE_URL }, null, 2), "utf-8");
}

function isManagedFirmwareReady(dir: string): boolean {
  return isUsableExtractedFirmwareRoot(dir)
    && fs.existsSync(path.join(dir, NEWLIB_COMPAT_SOURCE))
    && fs.existsSync(path.join(dir, LUAC_ASSERT_COMPAT_SOURCE))
    && fs.existsSync(path.join(dir, MARKER_FILE));
}

function isUsableExtractedFirmwareRoot(dir: string): boolean {
  return isBaseFirmwareRoot(dir)
    && SUBMODULES.every((submodule) => fs.existsSync(path.join(dir, submodule.path, submodule.requiredFile)));
}

function isBaseFirmwareRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, "CMakeLists.txt"))
    && fs.existsSync(path.join(dir, "app"));
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("No response body received");
  }
  const fileStream = fs.createWriteStream(outputPath);
  await finished(Readable.fromWeb(response.body as any).pipe(fileStream));
}

async function findFirmwareRoot(root: string): Promise<string | null> {
  if (isBaseFirmwareRoot(root)) return root;
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (isBaseFirmwareRoot(candidate)) return candidate;
  }
  return null;
}

async function hydrateSubmodules(firmwareRoot: string, tempRoot: string, onProgress?: (message: string) => void): Promise<void> {
  for (const submodule of SUBMODULES) {
    const destination = path.join(firmwareRoot, submodule.path);
    if (fs.existsSync(path.join(destination, submodule.requiredFile))) continue;

    onProgress?.(`Downloading ${submodule.path}`);
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.mkdir(destination, { recursive: true });

    const submoduleTemp = path.join(tempRoot, `submodule-${path.basename(submodule.path)}-${Date.now()}`);
    const zipPath = path.join(submoduleTemp, "source.zip");
    const extractRoot = path.join(submoduleTemp, "extract");
    await fsp.mkdir(extractRoot, { recursive: true });
    await downloadFile(submodule.url, zipPath);
    await extract(zipPath, { dir: extractRoot });
    const sourceRoot = await findSingleDirectory(extractRoot);
    if (!sourceRoot) throw new Error(`Downloaded submodule archive is empty: ${submodule.path}`);
    await copyDirectory(sourceRoot, destination);
  }
}

async function applyCompatibilityPatches(firmwareRoot: string): Promise<void> {
  const sourcePath = path.join(firmwareRoot, NEWLIB_COMPAT_SOURCE);
  await fsp.writeFile(sourcePath, `#include <stddef.h>

struct _reent;

extern void *malloc(size_t size);
extern void free(void *ptr);
extern void *realloc(void *ptr, size_t size);

void *_malloc_r(struct _reent *reent, size_t size)
{
  (void)reent;
  return malloc(size);
}

void _free_r(struct _reent *reent, void *ptr)
{
  (void)reent;
  free(ptr);
}

void *_realloc_r(struct _reent *reent, void *ptr, size_t size)
{
  (void)reent;
  return realloc(ptr, size);
}
`, "utf-8");

  const cmakePath = path.join(firmwareRoot, "app", "CMakeLists.txt");
  const cmake = await fsp.readFile(cmakePath, "utf-8");
  const before = "add_executable(${EXECUTABLE_NAME} dummy.c)";
  const after = "add_executable(${EXECUTABLE_NAME} dummy.c nodemcu-vscode-newlib.c)";
  if (!cmake.includes(after)) {
    await fsp.writeFile(cmakePath, cmake.replace(before, after), "utf-8");
  }

  const assertCompatPath = path.join(firmwareRoot, LUAC_ASSERT_COMPAT_SOURCE);
  await fsp.writeFile(assertCompatPath, `#include <stdio.h>
#include <stdlib.h>

void luaL_assertfail(const char *file, int line, const char *message)
{
  fprintf(stderr, "lua assertion failed: %s:%d: %s\\n", file, line, message);
  abort();
}
`, "utf-8");

  const luacCmakePath = path.join(firmwareRoot, "tools", "luac_cross", "CMakeLists.txt");
  const luacCmake = await fsp.readFile(luacCmakePath, "utf-8");
  const sourceNeedle = "${APP_DIR}/modules/pixbuf.c";
  const sourceReplacement = `${sourceNeedle}
    nodemcu-vscode-luac-assert.c`;
  if (!luacCmake.includes("nodemcu-vscode-luac-assert.c")) {
    await fsp.writeFile(luacCmakePath, luacCmake.replace(sourceNeedle, sourceReplacement), "utf-8");
  }
}

async function findSingleDirectory(root: string): Promise<string | null> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const directory = entries.find((entry) => entry.isDirectory());
  return directory ? path.join(root, directory.name) : null;
}

async function copyDirectory(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
    } else if (entry.isSymbolicLink()) {
      const link = await fsp.readlink(from);
      await fsp.symlink(link, to);
    } else {
      await fsp.copyFile(from, to);
    }
  }
}
