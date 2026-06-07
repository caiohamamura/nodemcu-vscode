import * as path from "node:path";
import * as fs from "node:fs";
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
    const esptool = esptoolScript(ctx.firmwarePath);
    const bin0 = path.join(binOutput(ctx.firmwarePath), "0x00000.bin");
    const bin1 = path.join(binOutput(ctx.firmwarePath), "0x10000.bin");
    const cmd = fs.existsSync(esptool)
      ? esptoolFlashCommand({
          python: ctx.python,
          esptool,
          port: ctx.port,
          baud: ctx.config.nodemcu.baud,
          flashMode: ctx.config.nodemcu.flash_mode,
          flashFreq: ctx.config.nodemcu.flash_freq,
          flashSize: ctx.config.nodemcu.flash_size,
          bin0,
          bin1,
          extraFiles: ctx.config.flash.extra_files,
        })
      : {
          command: ctx.python,
          args: [
            "-m", "esptool",
            "--port", ctx.port,
            "--baud", String(ctx.config.nodemcu.baud),
            "write_flash",
            "--flash_mode", ctx.config.nodemcu.flash_mode,
            "--flash_freq", ctx.config.nodemcu.flash_freq,
            "--flash_size", ctx.config.nodemcu.flash_size,
            "0x00000", bin0,
            "0x10000", bin1,
            ...ctx.config.flash.extra_files.flatMap((f) => [f.offset, f.path]),
          ],
        };
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
