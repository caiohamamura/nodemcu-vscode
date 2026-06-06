import { Shell } from "../util/shell";
import { esptoolFlashCommand } from "../build/toolchain";
import { esptoolScript, binOutput } from "../util/paths";
import type { NodemcuConfig } from "../config/nodemcuIni";

export interface FlashContext {
  python: string;
  firmwarePath: string;
  config: NodemcuConfig;
  port: string;
  onLog: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}

export interface FlashResult {
  success: boolean;
  exitCode: number | null;
  command: string;
  durationMs: number;
}

export class FlashManager {
  constructor(private shell: Shell) {}

  async flash(ctx: FlashContext): Promise<FlashResult> {
    const start = Date.now();
    const cmd = esptoolFlashCommand({
      python: ctx.python,
      esptool: esptoolScript(ctx.firmwarePath),
      port: ctx.port,
      baud: ctx.config.nodemcu.baud,
      flashMode: ctx.config.nodemcu.flash_mode,
      flashFreq: ctx.config.nodemcu.flash_freq,
      flashSize: ctx.config.nodemcu.flash_size,
      bin0: `${binOutput(ctx.firmwarePath)}/0x00000.bin`,
      bin1: `${binOutput(ctx.firmwarePath)}/0x10000.bin`,
      extraFiles: ctx.config.flash.extra_files,
    });
    const r = await this.shell.run(cmd.command, cmd.args, {
      onStdout: ctx.onLog,
      onStderr: ctx.onStderr,
    });
    return {
      success: r.exitCode === 0,
      exitCode: r.exitCode,
      command: cmd.args.join(" "),
      durationMs: Date.now() - start,
    };
  }
}
