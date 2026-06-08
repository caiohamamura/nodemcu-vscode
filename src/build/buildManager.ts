import * as fs from "node:fs";
import * as path from "node:path";
import { Shell } from "../util/shell";
import { ToolchainLocator, cmakeConfigureCommand, cmakeBuildCommand } from "./toolchain";
import { writeUserModulesHeader, diffSelectedModules, readSelectedModules } from "./userModulesWriter";
import { parseProblems, summarize } from "./outputParser";
import { defaultBuildDir, userModulesHeader, binOutput } from "../util/paths";
import type { NodemcuConfig } from "../config/nodemcuIni";
import type { CompileProblem } from "./outputParser";
import type { ToolchainInfo } from "./toolchain";

export interface BuildContext {
  firmwarePath: string;
  config: NodemcuConfig;
  parallel: boolean;
  jobCount: number;
  verbose: boolean;
  generator: "Ninja" | "Unix Makefiles" | "NMake Makefiles" | "MinGW Makefiles" | "MSYS Makefiles" | "Unknown";
  onLog: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface BuildResult {
  success: boolean;
  problems: CompileProblem[];
  summary: string;
  binPaths: { bin0: string; bin1: string };
  durationMs: number;
  needsReconfigure: boolean;
  modulesChanged: { added: string[]; removed: string[] };
}

export class BuildManager {
  constructor(private shell: Shell) {}

  async build(ctx: BuildContext): Promise<BuildResult> {
    const start = Date.now();
    const headerPath = userModulesHeader(ctx.firmwarePath);
    const before = readSelectedModules(headerPath);
    writeUserModulesHeader(headerPath, ctx.config);
    const after = readSelectedModules(headerPath);
    const diff = diffSelectedModules(before, after);
    const needsReconfigure = diff.added.length > 0 || diff.removed.length > 0;

    const buildDir = defaultBuildDir(ctx.firmwarePath);
    if (needsReconfigure) {
      const modulesSrcDir = path.join(ctx.firmwarePath, "app", "modules");
      const appCMakeLists = path.join(ctx.firmwarePath, "app", "CMakeLists.txt");
      const parseModulesCmake = path.join(ctx.firmwarePath, "cmake", "parse_user_modules_h.cmake");

      let headerMtime = 0;
      try { headerMtime = fs.statSync(headerPath).mtimeMs; } catch { }
      const futureTime = new Date(headerMtime + 2000);
      for (const f of [appCMakeLists, parseModulesCmake]) {
        try {
          if (fs.existsSync(f)) {
            const fmtime = fs.statSync(f).mtimeMs;
            if (headerMtime >= fmtime) {
              fs.utimesSync(f, futureTime, futureTime);
            }
          }
        } catch {
        }
      }
      if (headerMtime > 0) {
        try {
          const entries = fs.readdirSync(modulesSrcDir);
          for (const e of entries) {
            if (!e.endsWith(".c") || e === "module.c") continue;
            const cPath = path.join(modulesSrcDir, e);
            try {
              const cMtime = fs.statSync(cPath).mtimeMs;
              if (headerMtime >= cMtime) {
                fs.utimesSync(cPath, futureTime, futureTime);
              }
            } catch {
            }
          }
        } catch {
        }
      }
    }

    let generator: ToolchainInfo["generator"] = ctx.generator;
    if (generator === "Unknown") {
      const toolchain = await new ToolchainLocator(this.shell).locate();
      generator = toolchain.generator;
    }

    if (needsReconfigure) {
      const configureCmd = cmakeConfigureCommand({
        firmwarePath: ctx.firmwarePath,
        buildDir,
        generator,
        luaVersion: ctx.config.nodemcu.lua_version,
        luaNumberIntegral: ctx.config.nodemcu.lua_number_integral,
        luaNumber64bits: ctx.config.nodemcu.lua_number_64bits,
        verbose: ctx.verbose,
      });
      const configureResult = await this.shell.run(configureCmd.command, configureCmd.args, {
        cwd: configureCmd.cwd,
        onStdout: ctx.onLog,
        onStderr: ctx.onStderr,
        signal: ctx.signal,
      });
      if (configureResult.exitCode !== 0) {
        const combined = configureResult.stdout + configureResult.stderr;
        return {
          success: false,
          problems: parseProblems(combined),
          summary: `cmake configure failed (${configureResult.exitCode})`,
          binPaths: this.binPaths(ctx.firmwarePath),
          durationMs: Date.now() - start,
          needsReconfigure,
          modulesChanged: diff,
        };
      }
    }

    const buildCmd = cmakeBuildCommand({
      buildDir,
      parallel: ctx.parallel,
      jobCount: ctx.jobCount,
      verbose: ctx.verbose,
    });
    const buildResult = await this.shell.run(buildCmd.command, buildCmd.args, {
      cwd: buildCmd.cwd,
      onStdout: ctx.onLog,
      onStderr: ctx.onStderr,
      signal: ctx.signal,
    });

    const combined = buildResult.stdout + buildResult.stderr;
    const problems = parseProblems(combined);
    return {
      success: buildResult.exitCode === 0 && problems.filter((p) => p.severity === "error").length === 0,
      problems,
      summary: buildResult.exitCode === 0 ? summarize(problems) : `cmake build failed (${buildResult.exitCode})`,
      binPaths: this.binPaths(ctx.firmwarePath),
      durationMs: Date.now() - start,
      needsReconfigure,
      modulesChanged: diff,
    };
  }

  private binPaths(firmwarePath: string): { bin0: string; bin1: string } {
    const dir = binOutput(firmwarePath);
    return { bin0: `${dir}/0x00000.bin`, bin1: `${dir}/0x10000.bin` };
  }
}
