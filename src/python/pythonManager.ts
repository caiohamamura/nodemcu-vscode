import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as child_process from "node:child_process";

export interface PythonManagerOptions {
  storagePath: string;
  systemPython?: string;
  onProgress?: (message: string) => void;
}

export class PythonManager {
  private venvPath: string;
  private _venvPython = "";
  private readyPromise: Promise<string>;
  private readyResolve!: (value: string) => void;
  private readyReject!: (reason: unknown) => void;

  constructor(private opts: PythonManagerOptions) {
    this.venvPath = path.join(opts.storagePath, "python", "venv");
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.ensure().then(this.readyResolve, this.readyReject);
  }

  get pythonPromise(): Promise<string> {
    return this.readyPromise;
  }

  get python(): string {
    return this._venvPython;
  }

  private async ensure(): Promise<string> {
    const systemPython = this.opts.systemPython || await this.findSystemPython();
    if (!systemPython) {
      throw new Error("No Python found on system. Install Python 3.8+ and ensure it is on PATH.");
    }

    const venvPython = this.venvPythonPath();
    if (fs.existsSync(venvPython)) {
      const ok = await this.checkVenv(venvPython);
      if (ok) {
        this._venvPython = venvPython;
        return venvPython;
      }
      this.opts.onProgress?.("Recreating corrupted Python venv");
      await fsp.rm(this.venvPath, { recursive: true, force: true });
    }

    this.opts.onProgress?.(`Creating Python venv at ${this.venvPath}`);
    await fsp.mkdir(path.dirname(this.venvPath), { recursive: true });
    await this.runPython(systemPython, ["-m", "venv", this.venvPath]);
    const created = fs.existsSync(venvPython);
    if (!created) {
      throw new Error("Failed to create Python venv");
    }

    this.opts.onProgress?.("Installing esptool...");
    await this.runPython(venvPython, ["-m", "pip", "install", "esptool"]);

    this.opts.onProgress?.("Installing pyserial...");
    await this.runPython(venvPython, ["-m", "pip", "install", "pyserial"]);

    this._venvPython = venvPython;
    return venvPython;
  }

  private venvPythonPath(): string {
    return process.platform === "win32"
      ? path.join(this.venvPath, "Scripts", "python.exe")
      : path.join(this.venvPath, "bin", "python");
  }

  private async checkVenv(pythonPath: string): Promise<boolean> {
    try {
      const r = await this.runPython(pythonPath, ["-c", "import esptool; import serial; print('ok')"]);
      return r.includes("ok");
    } catch {
      return false;
    }
  }

  private async findSystemPython(): Promise<string | null> {
    const candidates = ["python", "python3", "py"];
    for (const candidate of candidates) {
      try {
        const p = await this.which(candidate);
        if (p) {
          const r = await this.runPython(p, ["--version"]);
          if (r) return p;
        }
      } catch {
        // try next
      }
    }
    return null;
  }

  private which(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      const cmd = process.platform === "win32" ? "where" : "which";
      child_process.execFile(cmd, [name], { windowsHide: true }, (err, stdout) => {
        if (err) resolve(null);
        else resolve(stdout.trim().split(/\r?\n/)[0]);
      });
    });
  }

  private runPython(python: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      child_process.execFile(python, args, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout.trim());
      });
    });
  }
}
