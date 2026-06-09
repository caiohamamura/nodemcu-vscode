import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import extract from "extract-zip";

const CMAKE_VERSION = "3.28.3";
const NINJA_VERSION = "1.11.1";
const PYTHON_VERSION = "3.12.3";
const PYTHON_STANDALONE_TAG = "20240415";

export interface ManagedToolsOptions {
  storageRoot: string;
  onProgress?: (message: string) => void;
}

export async function ensureCMake(opts: ManagedToolsOptions): Promise<string> {
  const cmakeDir = path.join(opts.storageRoot, "tools", "cmake");
  const existing = findCMakeBinary(cmakeDir);
  if (existing) return existing;

  const spec = cmakeDownloadSpec();
  const toolsDir = path.join(opts.storageRoot, "tools");
  await fsp.mkdir(toolsDir, { recursive: true });

  const archivePath = path.join(toolsDir, `cmake-${CMAKE_VERSION}${spec.ext}`);

  if (!fs.existsSync(archivePath)) {
    opts.onProgress?.(`Downloading CMake ${CMAKE_VERSION}`);
    await downloadFile(spec.url, archivePath);
  }

  await fsp.rm(cmakeDir, { recursive: true, force: true });
  await fsp.mkdir(cmakeDir, { recursive: true });

  opts.onProgress?.(`Extracting CMake ${CMAKE_VERSION}`);
  await extractToDir(archivePath, cmakeDir, true);

  const binary = findCMakeBinary(cmakeDir);
  if (!binary) {
    throw new Error(`CMake binary not found after extraction in ${cmakeDir}`);
  }

  await fsp.unlink(archivePath).catch(() => {});
  opts.onProgress?.(`CMake ${CMAKE_VERSION} ready`);
  return binary;
}

export async function ensureNinja(opts: ManagedToolsOptions): Promise<string> {
  const ninjaDir = path.join(opts.storageRoot, "tools", "ninja");
  const binName = os.platform() === "win32" ? "ninja.exe" : "ninja";
  const binPath = path.join(ninjaDir, binName);

  if (fs.existsSync(binPath)) return binPath;

  const url = ninjaDownloadUrl();
  const toolsDir = path.join(opts.storageRoot, "tools");
  await fsp.mkdir(toolsDir, { recursive: true });

  const archivePath = path.join(toolsDir, `ninja-${NINJA_VERSION}.zip`);

  if (!fs.existsSync(archivePath)) {
    opts.onProgress?.(`Downloading Ninja ${NINJA_VERSION}`);
    await downloadFile(url, archivePath);
  }

  await fsp.rm(ninjaDir, { recursive: true, force: true });
  await fsp.mkdir(ninjaDir, { recursive: true });

  opts.onProgress?.(`Extracting Ninja ${NINJA_VERSION}`);
  await extractToDir(archivePath, ninjaDir, false);

  if (!fs.existsSync(binPath)) {
    throw new Error(`Ninja binary not found after extraction in ${ninjaDir}`);
  }

  if (os.platform() !== "win32") {
    await fsp.chmod(binPath, 0o755);
  }

  await fsp.unlink(archivePath).catch(() => {});
  opts.onProgress?.(`Ninja ${NINJA_VERSION} ready`);
  return binPath;
}

export async function ensureManagedPython(opts: ManagedToolsOptions): Promise<string> {
  const pythonDir = path.join(opts.storageRoot, "tools", "python");
  const existing = findPythonBinary(pythonDir);
  if (existing) return existing;

  const spec = pythonDownloadSpec();
  const toolsDir = path.join(opts.storageRoot, "tools");
  await fsp.mkdir(toolsDir, { recursive: true });

  const archivePath = path.join(toolsDir, `python-${PYTHON_VERSION}${spec.ext}`);

  if (!fs.existsSync(archivePath)) {
    opts.onProgress?.(`Downloading Python ${PYTHON_VERSION}`);
    await downloadFile(spec.url, archivePath);
  }

  await fsp.rm(pythonDir, { recursive: true, force: true });
  await fsp.mkdir(pythonDir, { recursive: true });

  opts.onProgress?.(`Extracting Python ${PYTHON_VERSION}`);
  await extractToDir(archivePath, pythonDir, true);

  const binary = findPythonBinary(pythonDir);
  if (!binary) {
    throw new Error(`Python binary not found after extraction in ${pythonDir}`);
  }

  if (os.platform() !== "win32") {
    await fsp.chmod(binary, 0o755);
  }

  await fsp.unlink(archivePath).catch(() => {});
  opts.onProgress?.(`Python ${PYTHON_VERSION} ready`);
  return binary;
}

function findCMakeBinary(cmakeDir: string): string | null {
  const binName = os.platform() === "win32" ? "cmake.exe" : "cmake";
  const candidates = [
    path.join(cmakeDir, "bin", binName),
    path.join(cmakeDir, "CMake.app", "Contents", "bin", "cmake"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findPythonBinary(pythonDir: string): string | null {
  const candidates = [
    path.join(pythonDir, "python.exe"),
    path.join(pythonDir, "bin", "python3"),
    path.join(pythonDir, "bin", "python"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function pythonDownloadSpec(): { url: string; ext: string } {
  const platform = os.platform();
  const arch = os.arch();

  let platformStr: string;
  if (platform === "win32") {
    platformStr = "x86_64-pc-windows-msvc";
  } else if (platform === "linux") {
    platformStr = arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  } else if (platform === "darwin") {
    platformStr = arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin";
  } else {
    throw new Error(`Unsupported platform for managed Python: ${platform}`);
  }

  const ext = ".tar.gz";
  const filename = `cpython-${PYTHON_VERSION}+${PYTHON_STANDALONE_TAG}-${platformStr}-install_only${ext}`;
  const url = `https://github.com/indygreg/python-build-standalone/releases/download/${PYTHON_STANDALONE_TAG}/${filename}`;
  return { url, ext };
}

function cmakeDownloadSpec(): { url: string; ext: string } {
  const platform = os.platform();
  const arch = os.arch();

  let platformStr: string;
  if (platform === "win32") {
    platformStr = "windows-x86_64";
  } else if (platform === "linux") {
    platformStr = arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
  } else if (platform === "darwin") {
    platformStr = "macos-universal";
  } else {
    throw new Error(`Unsupported platform for managed CMake: ${platform}`);
  }

  const ext = platform === "win32" ? ".zip" : ".tar.gz";
  const url = `https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-${platformStr}${ext}`;
  return { url, ext };
}

function ninjaDownloadUrl(): string {
  const platform = os.platform();
  let platformStr: string;
  if (platform === "win32") platformStr = "win";
  else if (platform === "linux") platformStr = "linux";
  else if (platform === "darwin") platformStr = "mac";
  else throw new Error(`Unsupported platform for managed Ninja: ${platform}`);

  return `https://github.com/ninja-build/ninja/releases/download/v${NINJA_VERSION}/ninja-${platformStr}.zip`;
}

async function extractToDir(archivePath: string, destDir: string, stripTopDir: boolean): Promise<void> {
  if (archivePath.endsWith(".zip")) {
    if (stripTopDir) {
      const tempDir = `${destDir}-extract-${Date.now()}`;
      await fsp.mkdir(tempDir, { recursive: true });
      await extract(archivePath, { dir: tempDir });
      const entries = await fsp.readdir(tempDir, { withFileTypes: true });
      const source = entries.length === 1 && entries[0].isDirectory()
        ? path.join(tempDir, entries[0].name)
        : tempDir;
      await moveContents(source, destDir);
      await fsp.rm(tempDir, { recursive: true, force: true });
    } else {
      await extract(archivePath, { dir: destDir });
    }
  } else {
    const args = ["-xzf", archivePath, "-C", destDir];
    if (stripTopDir) args.push("--strip-components=1");
    child_process.execFileSync("tar", args, { windowsHide: true, stdio: "pipe" });
  }
}

async function moveContents(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    try {
      await fsp.rename(from, to);
    } catch {
      if (entry.isDirectory()) {
        await copyDir(from, to);
        await fsp.rm(from, { recursive: true, force: true });
      } else {
        await fsp.copyFile(from, to);
        await fsp.unlink(from);
      }
    }
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else {
      await fsp.copyFile(from, to);
    }
  }
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
  if (!response.body) throw new Error("No response body");
  const stream = fs.createWriteStream(outputPath);
  await finished(Readable.fromWeb(response.body as any).pipe(stream));
}
