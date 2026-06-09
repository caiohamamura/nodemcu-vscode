import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import * as child_process from "node:child_process";
import { ensureCMake, ensureNinja, ensureManagedPython } from "../../src/tools/managedTools";
import { PythonManager } from "../../src/python/pythonManager";

let tmp: string;
let storageRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-vscode-tools-"));
  storageRoot = path.join(tmp, "storage");
  fs.mkdirSync(storageRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createFakeBinary(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, "fake binary");
  if (os.platform() !== "win32") {
    fs.chmodSync(binPath, 0o755);
  }
  return binPath;
}

describe("ensureCMake", () => {
  it("returns existing cmake binary if already extracted", async () => {
    const cmakeDir = path.join(storageRoot, "tools", "cmake");
    const binName = os.platform() === "win32" ? "cmake.exe" : "cmake";
    const expectedPath = createFakeBinary(path.join(cmakeDir, "bin"), binName);

    const result = await ensureCMake({ storageRoot });
    expect(result).toBe(expectedPath);
  });

  it("throws error when download fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(ensureCMake({ storageRoot })).rejects.toThrow("Download failed");
  });

  it("reports progress during download", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    vi.stubGlobal("fetch", mockFetch);

    const progressMessages: string[] = [];
    try {
      await ensureCMake({
        storageRoot,
        onProgress: (msg) => progressMessages.push(msg),
      });
    } catch {
    }

    expect(progressMessages.some(m => m.includes("Downloading CMake"))).toBe(true);
  });
});

describe("ensureNinja", () => {
  it("returns existing ninja binary if already extracted", async () => {
    const ninjaDir = path.join(storageRoot, "tools", "ninja");
    const binName = os.platform() === "win32" ? "ninja.exe" : "ninja";
    const expectedPath = createFakeBinary(ninjaDir, binName);

    const result = await ensureNinja({ storageRoot });
    expect(result).toBe(expectedPath);
  });

  it("throws error when download fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(ensureNinja({ storageRoot })).rejects.toThrow("Download failed");
  });
});

describe("ensureManagedPython", () => {
  it("returns existing python binary if already extracted", async () => {
    const pythonDir = path.join(storageRoot, "tools", "python");
    const binName = os.platform() === "win32" ? "python.exe" : "python3";
    const binDir = os.platform() === "win32" ? pythonDir : path.join(pythonDir, "bin");
    const expectedPath = createFakeBinary(binDir, binName);

    const result = await ensureManagedPython({ storageRoot });
    expect(result).toBe(expectedPath);
  });

  it("throws error when download fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(ensureManagedPython({ storageRoot })).rejects.toThrow("Download failed");
  });

  it("reports progress during download", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal("fetch", mockFetch);

    const progressMessages: string[] = [];
    try {
      await ensureManagedPython({
        storageRoot,
        onProgress: (msg) => progressMessages.push(msg),
      });
    } catch {
    }

    expect(progressMessages.some(m => m.includes("Downloading Python"))).toBe(true);
  });
});

describe("PythonManager with and without system Python", () => {
  let pythonStoragePath: string;

  beforeEach(() => {
    pythonStoragePath = path.join(storageRoot, "python-test");
    fs.mkdirSync(pythonStoragePath, { recursive: true });
    vi.mocked(child_process.execFile).mockReset();
    vi.mocked(child_process.execFileSync).mockReset();
  });

  it("uses system Python when available and creates venv", async () => {
    const fakeSystemPython = path.join(tmp, "system-python");
    fs.mkdirSync(fakeSystemPython, { recursive: true });
    const pythonBin = path.join(fakeSystemPython, os.platform() === "win32" ? "python.exe" : "python");
    fs.writeFileSync(pythonBin, "fake python");
    if (os.platform() !== "win32") fs.chmodSync(pythonBin, 0o755);

    vi.mocked(child_process.execFile).mockImplementation((_cmd: any, args: any, options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (args.includes("--version")) {
        cb?.(null, "Python 3.12.0", "");
      } else if (args.includes("venv")) {
        const venvPath = args[args.length - 1];
        const venvBin = os.platform() === "win32"
          ? path.join(venvPath, "Scripts")
          : path.join(venvPath, "bin");
        fs.mkdirSync(venvBin, { recursive: true });
        const venvPython = os.platform() === "win32"
          ? path.join(venvBin, "python.exe")
          : path.join(venvBin, "python");
        fs.writeFileSync(venvPython, "venv python");
        cb?.(null, "", "");
      } else if (args.includes("-c")) {
        cb?.(null, "ok", "");
      } else {
        cb?.(null, "", "");
      }
      return {} as any;
    });

    const progressMessages: string[] = [];
    const mgr = new PythonManager({
      storagePath: pythonStoragePath,
      systemPython: pythonBin,
      onProgress: (msg) => progressMessages.push(msg),
    });

    await mgr.pythonPromise;
    expect(mgr.python).toContain("python");
    expect(progressMessages.some(m => m.includes("Creating Python venv"))).toBe(true);
    expect(progressMessages.some(m => m.includes("Installing esptool"))).toBe(true);
  });

  it("falls back to managed Python when no system Python found", async () => {
    vi.mocked(child_process.execFile).mockImplementation((cmd: any, args: any, options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (cmd === "where" || cmd === "which") {
        const err = new Error("not found") as any;
        err.code = 1;
        cb?.(err, "", "");
      } else if (args.includes("--version")) {
        cb?.(null, "Python 3.12.0", "");
      } else if (args.includes("venv")) {
        const venvPath = args[args.length - 1];
        const venvBin = os.platform() === "win32"
          ? path.join(venvPath, "Scripts")
          : path.join(venvPath, "bin");
        fs.mkdirSync(venvBin, { recursive: true });
        const venvPython = os.platform() === "win32"
          ? path.join(venvBin, "python.exe")
          : path.join(venvBin, "python");
        fs.writeFileSync(venvPython, "venv python");
        cb?.(null, "", "");
      } else if (args.includes("-c")) {
        cb?.(null, "ok", "");
      } else {
        cb?.(null, "", "");
      }
      return {} as any;
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal("fetch", mockFetch);

    const progressMessages: string[] = [];
    const mgr = new PythonManager({
      storagePath: pythonStoragePath,
      onProgress: (msg) => progressMessages.push(msg),
    });

    await expect(mgr.pythonPromise).rejects.toThrow();
    expect(progressMessages.some(m => m.includes("No system Python"))).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("reuses existing venv if already created", async () => {
    const venvPath = path.join(pythonStoragePath, "python", "venv");
    const venvBin = os.platform() === "win32"
      ? path.join(venvPath, "Scripts")
      : path.join(venvPath, "bin");
    fs.mkdirSync(venvBin, { recursive: true });
    const venvPython = os.platform() === "win32"
      ? path.join(venvBin, "python.exe")
      : path.join(venvBin, "python");
    fs.writeFileSync(venvPython, "existing venv python");

    vi.mocked(child_process.execFile).mockImplementation((_cmd: any, args: any, options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (args.includes("-c") && args[args.length - 1].includes("esptool")) {
        cb?.(null, "ok", "");
      }
      return {} as any;
    });

    const mgr = new PythonManager({
      storagePath: pythonStoragePath,
      systemPython: "/fake/python",
    });

    await mgr.pythonPromise;
    expect(mgr.python).toBe(venvPython);
  });
});
