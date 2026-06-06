import { spawn, type ChildProcess } from "node:child_process";

export interface ShellRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  windowsHide?: boolean;
}

export interface ShellRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export class Shell {
  private env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = { ...env };
  }

  setEnv(extra: NodeJS.ProcessEnv): void {
    this.env = { ...this.env, ...extra };
  }

  async run(command: string, args: string[], opts: ShellRunOptions = {}): Promise<ShellRunResult> {
    return await new Promise<ShellRunResult>((resolve, reject) => {
      const child: ChildProcess = spawn(command, args, {
        cwd: opts.cwd,
        env: this.env,
        windowsHide: opts.windowsHide ?? true,
        signal: opts.signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf-8");
        stdout += s;
        opts.onStdout?.(s);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf-8");
        stderr += s;
        opts.onStderr?.(s);
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code, signal) => {
        resolve({ exitCode: code, signal, stdout, stderr });
      });
    });
  }

  async which(binary: string): Promise<string | null> {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    try {
      const r = await this.run(whichCmd, [binary]);
      if (r.exitCode !== 0) return null;
      return r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? null;
    } catch {
      return null;
    }
  }
}

export interface CommandSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function quoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    if (/[\s"&|<>^()]/.test(arg)) {
      return `"${arg.replace(/"/g, '""')}"`;
    }
    return arg;
  }
  if (/[\s'"$`\\|&;<>(){}*?!]/.test(arg)) {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
  }
  return arg;
}

export function formatCommand(spec: CommandSpec, platform: NodeJS.Platform = process.platform): string {
  const parts = [spec.command, ...spec.args].map((a) => quoteArg(a, platform));
  return parts.join(" ");
}
