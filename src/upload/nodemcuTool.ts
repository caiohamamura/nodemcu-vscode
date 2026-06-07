import { Shell } from "../util/shell";
import * as fs from "node:fs";
import * as path from "node:path";

export interface NodemcuToolOptions {
  python: string;
  port: string;
  baud: number;
  baudUpload: number;
  compile: boolean;
  run?: boolean;
}

export interface FileEntry {
  name: string;
  size: number;
}

export class NodemcuTool {
  constructor(private shell: Shell) {}

  private command(): { command: string; argsPrefix: string[] } {
    const override = process.env.NODEMCU_VSCODE_NODEMCU_TOOL;
    if (override && fs.existsSync(override)) {
      return { command: "node", argsPrefix: [override] };
    }
    const localScript = path.resolve(__dirname, "..", "node_modules", "nodemcu-tool", "bin", "nodemcu-tool.js");
    const sourceTreeScript = path.resolve(__dirname, "..", "..", "node_modules", "nodemcu-tool", "bin", "nodemcu-tool.js");
    const script = fs.existsSync(localScript) ? localScript : sourceTreeScript;
    if (fs.existsSync(script)) return { command: "node", argsPrefix: [script] };
    return { command: "nodemcu-tool", argsPrefix: [] };
  }

  private args(opts: NodemcuToolOptions, commandArgs: string[]): { command: string; args: string[] } {
    const cmd = this.command();
    return {
      command: cmd.command,
      args: [
        ...cmd.argsPrefix,
        "--port", opts.port,
        "--baud", String(opts.baudUpload || opts.baud),
        "--connection-delay", "1000",
        ...commandArgs,
      ],
    };
  }

  async isInstalled(_python: string): Promise<boolean> {
    const cmd = this.command();
    const r = await this.shell.run(cmd.command, [...cmd.argsPrefix, "--version"]);
    return r.exitCode === 0;
  }

  async install(_python: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const r = await this.shell.run("npm", ["install", "nodemcu-tool"], { onStdout: onLog, onStderr: onLog });
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  private async runWithDelay(command: string, args: string[], options?: any): Promise<any> {
    const r = await this.shell.run(command, args, options);
    if (process.platform === "win32") {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return r;
  }

  async upload(opts: NodemcuToolOptions, localPath: string, remoteName: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const cmd = this.args(opts, [
      "upload",
      ...(opts.compile ? ["--compile"] : []),
      ...(opts.run ? ["--run"] : []),
      "--remotename", remoteName,
      localPath,
    ]);
    const r = await this.runWithDelay(cmd.command, cmd.args, { onStdout: onLog, onStderr: onLog });
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  async download(opts: NodemcuToolOptions, remoteName: string, localPath: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const destinationDir = path.dirname(localPath);
    const downloadedPath = path.join(destinationDir, remoteName);
    const cmd = this.args(opts, ["download", remoteName]);
    const r = await this.runWithDelay(cmd.command, cmd.args, { cwd: destinationDir, onStdout: onLog, onStderr: onLog });
    if (r.exitCode === 0 && downloadedPath !== localPath && fs.existsSync(downloadedPath)) {
      fs.renameSync(downloadedPath, localPath);
    }
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  async remove(opts: NodemcuToolOptions, remoteName: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const cmd = this.args(opts, ["remove", remoteName]);
    const r = await this.runWithDelay(cmd.command, cmd.args, { onStdout: onLog, onStderr: onLog });
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  async runFile(opts: NodemcuToolOptions, remoteName: string, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const cmd = this.args(opts, ["run", remoteName]);
    const r = await this.runWithDelay(cmd.command, cmd.args, { onStdout: onLog, onStderr: onLog });
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  async reset(opts: NodemcuToolOptions, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const cmd = this.args(opts, ["reset"]);
    const r = await this.runWithDelay(cmd.command, cmd.args, { onStdout: onLog, onStderr: onLog });
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  async mkfs(opts: NodemcuToolOptions, onLog: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const cmd = this.args(opts, ["mkfs", "--noninteractive"]);
    const r = await this.runWithDelay(cmd.command, cmd.args, { onStdout: onLog, onStderr: onLog });
    return r.exitCode === 0 ? { success: true } : { success: false, error: r.stderr || r.stdout };
  }

  async listFiles(opts: NodemcuToolOptions, onLog: (s: string) => void): Promise<FileEntry[]> {
    const cmd = this.args(opts, ["fsinfo", "--json"]);
    const r = await this.runWithDelay(cmd.command, cmd.args, { onStdout: onLog, onStderr: onLog });
    if (r.exitCode !== 0) return [];
    try {
      const parsed = JSON.parse(r.stdout) as { files?: Array<{ name: string; size: number }> };
      return (parsed.files ?? []).map((f) => ({ name: f.name, size: Number(f.size) || 0 }));
    } catch {
      // Fall back to the legacy parser used by older tests and hand-written stubs.
    }
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
