import { Shell } from "../util/shell";

export interface NodemcuToolOptions {
  python: string;
  port: string;
  baud: number;
  baudUpload: number;
  compile: boolean;
}

export interface FileEntry {
  name: string;
  size: number;
}

export class NodemcuTool {
  constructor(private shell: Shell) {}

  async isInstalled(python: string): Promise<boolean> {
    const r = await this.shell.run(python, ["-c", "import nodemcu_tool; print(getattr(nodemcu_tool, '__version__', 'ok'))"]);
    return r.exitCode === 0;
  }

  async install(python: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const r = await this.shell.run(python, ["-m", "pip", "install", "--user", "nodemcu-tool"], { onStdout: onLog, onStderr: onLog });
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  async upload(opts: NodemcuToolOptions, localPath: string, remoteName: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const args = [
      "-m", "nodemcu_tool",
      "--port", opts.port,
      "--baud", String(opts.baudUpload),
      "upload",
      opts.compile ? "-c" : "-f",
      localPath,
      remoteName,
    ];
    const r = await this.shell.run(opts.python, args, { onStdout: onLog, onStderr: onLog });
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  async download(opts: NodemcuToolOptions, remoteName: string, localPath: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const args = [
      "-m", "nodemcu_tool",
      "--port", opts.port,
      "--baud", String(opts.baudUpload),
      "download",
      remoteName,
      localPath,
    ];
    const r = await this.shell.run(opts.python, args, { onStdout: onLog, onStderr: onLog });
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  async remove(opts: NodemcuToolOptions, remoteName: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const args = [
      "-m", "nodemcu_tool",
      "--port", opts.port,
      "--baud", String(opts.baudUpload),
      "remove",
      remoteName,
    ];
    const r = await this.shell.run(opts.python, args, { onStdout: onLog, onStderr: onLog });
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  async listFiles(opts: NodemcuToolOptions, onLog: (s: string) => void): Promise<FileEntry[]> {
    const args = [
      "-m", "nodemcu_tool",
      "--port", opts.port,
      "--baud", String(opts.baudUpload),
      "ls",
    ];
    const r = await this.shell.run(opts.python, args, { onStdout: onLog, onStderr: onLog });
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((line) => {
        const parts = line.split(/\s+/);
        const size = Number(parts[parts.length - 1]);
        const name = parts.slice(0, -1).join(" ");
        return { name, size: Number.isFinite(size) ? size : 0 };
      });
  }
}
