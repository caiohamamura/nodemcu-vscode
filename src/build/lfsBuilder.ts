import type { Shell, CommandSpec } from "../util/shell";

export interface LfsImageOptions {
  luacCross: string;
  files: string[];
  outPath: string;
  maxSize: number;
  onLog?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface LfsImageResult {
  success: boolean;
  outPath: string;
  error?: string;
}

/**
 * Build the `luac.cross` argv that compiles the given Lua files into a flash
 * image (`-f`) of at most `maxSize` bytes (`-m`). Pure, so the command is
 * unit-testable. The basename of each input (minus `.lua`) becomes the module
 * name inside LFS, resolvable on-device via `require()` / `node.flashindex`.
 */
export function lfsImageCommand(opts: { luacCross: string; files: string[]; outPath: string; maxSize: number }): CommandSpec {
  const args = ["-f", "-m", String(Math.floor(opts.maxSize)), "-o", opts.outPath, ...opts.files];
  return { command: opts.luacCross, args };
}

/** Run {@link lfsImageCommand} via the shell, returning success + any error text. */
export async function buildLfsImage(shell: Shell, opts: LfsImageOptions): Promise<LfsImageResult> {
  if (opts.files.length === 0) {
    return { success: false, outPath: opts.outPath, error: "No Lua files to compile into the LFS image." };
  }
  const spec = lfsImageCommand(opts);
  const result = await shell.run(spec.command, spec.args, {
    onStdout: opts.onLog,
    onStderr: opts.onStderr,
    signal: opts.signal,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return { success: false, outPath: opts.outPath, error: detail || `luac.cross exited ${result.exitCode}` };
  }
  return { success: true, outPath: opts.outPath };
}
