import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import extract from "extract-zip";

export const MANAGED_FIRMWARE_TAG = "v3.1.2";
export const MANAGED_FIRMWARE_URL = `https://github.com/caiohamamura/nodemcu-firmware/archive/refs/tags/${MANAGED_FIRMWARE_TAG}.zip`;

const TOOLCHAIN_TARBALL = "xtensa-lx106-elf-win32-1.22.0-88-gde0bdc1-4.8.5.tar.gz";
const TOOLCHAIN_URL = `https://dl.espressif.com/dl/${TOOLCHAIN_TARBALL}`;
const TOOLCHAIN_DIR = `esp8266-xtensa-lx106-elf-win32-1.22.0-88-gde0bdc1-4.8.5`;

const MARKER_FILE = ".nodemcu-vscode-managed-firmware.json";

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
    await preExtractToolchain(root, opts.onProgress);
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
    await preExtractToolchain(root, opts.onProgress);

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
  if (!isUsableExtractedFirmwareRoot(dir)
    || !fs.existsSync(path.join(dir, MARKER_FILE))) {
    return false;
  }
  return true;
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

async function preExtractToolchain(firmwareRoot: string, onProgress?: (msg: string) => void): Promise<void> {
  const toolchainDir = path.join(firmwareRoot, "tools", "toolchains", TOOLCHAIN_DIR);
  if (fs.existsSync(path.join(toolchainDir, "bin"))) return;

  const isWindows = os.platform() === "win32";
  if (!isWindows) return; // Linux toolchain is different; let cmake handle it

  onProgress?.("Pre-extracting ESP8266 toolchain (cmake 4.x compat)");

  const toolsDir = path.join(firmwareRoot, "tools", "toolchains");
  await fsp.mkdir(toolsDir, { recursive: true });

  const tarballPath = path.join(toolsDir, TOOLCHAIN_TARBALL);
  if (!fs.existsSync(tarballPath)) {
    onProgress?.(`Downloading ${TOOLCHAIN_TARBALL}`);
    await downloadFile(TOOLCHAIN_URL, tarballPath);
  }

  await fsp.mkdir(toolchainDir, { recursive: true });

  try {
    child_process.execFileSync("tar", ["-xzf", tarballPath, "-C", toolchainDir, "--strip-components=1"], {
      windowsHide: true,
      stdio: "pipe",
    });
  } catch (err) {
    // If tar fails, cmake's FetchContent will try during configure
    onProgress?.(`Toolchain pre-extraction failed, will fall back to cmake: ${err}`);
    return;
  }

  if (fs.existsSync(path.join(toolchainDir, "bin"))) {
    await fsp.unlink(tarballPath).catch(() => {});
    onProgress?.("Toolchain pre-extracted successfully");
  }
}
