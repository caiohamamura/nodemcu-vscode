import * as fs from "node:fs";
import * as path from "node:path";
import { Shell } from "../util/shell";
import { ToolchainLocator, cmakeConfigureCommand, cmakeBuildCommand } from "./toolchain";
import { writeUserModulesHeader, diffSelectedModules, readSelectedModules, writeUserConfigSsl, writeUserConfigLfs, writeUserConfigBitRate, isTlsEnabled } from "./userModulesWriter";
import { writeU8g2FontsHeader, writeU8g2DisplaysHeader, writeUcgConfigHeader } from "./graphicsConfigWriter";
import { parseProblems, summarize } from "./outputParser";
import { appModulesDir, defaultBuildDir, userModulesHeader, userConfigHeader, u8g2FontsHeader, u8g2DisplaysHeader, ucgConfigHeader, binOutput, toolchainBinDirs, luacCrossPath } from "../util/paths";
import { luacFlavour, writeInstalledLuacFlavour } from "../firmware/prebuiltLuacCross";
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
  preferredCmake?: string;
  preferredNinja?: string;
  python?: string;
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
    // Keep CLIENT_SSL_ENABLE / SSL_BUFFER_SIZE in user_config.h in lockstep with
    // the tls module so enabling tls alone yields a working HTTPS/TLS firmware.
    const sslChanged = writeUserConfigSsl(userConfigHeader(ctx.firmwarePath), isTlsEnabled(ctx.config), ctx.config.build.ssl_buffer_size);
    // Allocating/freeing the LFS partition (LUA_FLASH_STORE) changes the firmware
    // layout, so a change here forces a reconfigure + reflash just like the SSL
    // toggle above.
    const lfsChanged = writeUserConfigLfs(userConfigHeader(ctx.firmwarePath), ctx.config.build.lfs_size);
    // Sync the firmware boot UART speed (BIT_RATE_DEFAULT) with [nodemcu] baud so
    // the flashed device comes up at the configured rate instead of the firmware
    // default. This is a source edit (user_config.h), so a change forces a
    // reconfigure + reflash like the SSL/LFS toggles above.
    const bitRateChanged = writeUserConfigBitRate(userConfigHeader(ctx.firmwarePath), ctx.config.nodemcu.baud);
    // Regenerate the u8g2/ucg font + display tables from the nodemcu.ini graphics
    // sections. Like the user_config.h toggles above these are source-header
    // edits, so a change must force a reconfigure + reflash. Empty sections are
    // a no-op (the writers preserve the firmware's shipped defaults).
    const u8g2FontsChanged = writeU8g2FontsHeader(u8g2FontsHeader(ctx.firmwarePath), ctx.config);
    const u8g2DisplaysChanged = writeU8g2DisplaysHeader(u8g2DisplaysHeader(ctx.firmwarePath), ctx.config, ctx.firmwarePath);
    const ucgChanged = writeUcgConfigHeader(ucgConfigHeader(ctx.firmwarePath), ctx.config, ctx.firmwarePath);
    const graphicsChanged = u8g2FontsChanged || u8g2DisplaysChanged || ucgChanged;
    const buildDir = defaultBuildDir(ctx.firmwarePath);
    const modulesSrcDir = appModulesDir(ctx.firmwarePath);
    // A build dir counts as "configured" only if CMake finished the generate
    // phase. CMakeCache.txt is written early during configure, but the
    // generator's build file (build.ninja / Makefile) is written last. An
    // interrupted or failed first configure leaves the cache without the build
    // file; trusting the cache alone makes every later build skip reconfigure
    // and then die in `cmake --build` with "cannot find build.ninja". Require
    // both so a failed configure is retried instead of permanently wedging.
    const cacheExists = fs.existsSync(path.join(buildDir, "CMakeCache.txt"));
    const generatorFileExists =
      fs.existsSync(path.join(buildDir, "build.ninja")) ||
      fs.existsSync(path.join(buildDir, "Makefile"));
    const buildDirMissing = !cacheExists || !generatorFileExists;
    // The Lua flavour (5.1/5.3, integral/64-bit) is a configure-time -D flag, not
    // a source edit, so a change to it would otherwise be skipped — leaving the
    // firmware (and the luac.cross host tool, which follows -DLUA) built for the
    // previous Lua version. A mismatched luac.cross silently emits images the
    // device's LFS loader rejects, so treat a Lua-flavour change as needing a
    // reconfigure.
    const luaFlavourChanged = !buildDirMissing && this.luaFlavourChanged(buildDir, ctx.config);
    const needsReconfigure = buildDirMissing || diff.added.length > 0 || diff.removed.length > 0 || sslChanged || lfsChanged || bitRateChanged || luaFlavourChanged || graphicsChanged;
    if (needsReconfigure) {
      // The firmware is a CMake superbuild: the real compile runs inside an
      // ExternalProject whose build step is gated by stamp files that the
      // outer ninja does not invalidate when only user_modules.h changes.
      // Without removing them the outer build reports "no work to do" and a
      // subsequent flash writes stale binaries. The inner build is properly
      // dependency-tracked, so this stays incremental.
      for (const stamp of [
        path.join(buildDir, "firmware-prefix", "src", "firmware-stamp", "firmware-configure"),
        path.join(buildDir, "firmware-prefix", "src", "firmware-stamp", "firmware-build"),
        path.join(buildDir, "firmware-prefix", "src", "firmware-stamp", "firmware-done"),
        path.join(buildDir, "CMakeFiles", "firmware-complete"),
      ]) {
        try { fs.rmSync(stamp, { force: true }); } catch { }
      }
      const innerCache = path.join(buildDir, "firmware_build", "CMakeCache.txt");
      try { fs.rmSync(path.join(buildDir, "CMakeCache.txt"), { force: true }); } catch { }
      try { fs.rmSync(path.join(buildDir, "CMakeFiles"), { recursive: true, force: true }); } catch { }
      try { fs.rmSync(innerCache, { force: true }); } catch { }
      try { fs.rmSync(path.join(buildDir, "firmware_build", "CMakeFiles"), { recursive: true, force: true }); } catch { }
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
    let cmake = ctx.preferredCmake || "cmake";
    let ninja = ctx.preferredNinja;
    let python = ctx.python;
    if (generator === "Unknown") {
      const toolchain = await new ToolchainLocator(this.shell, ctx.python, ctx.preferredCmake, ctx.preferredNinja).locate();
      generator = toolchain.generator;
      cmake = toolchain.cmake;
      ninja = toolchain.ninja;
      python = python || toolchain.python;
    }

    const env = { ...process.env };
    if (ninja) env.PATH = `${path.dirname(ninja)}${path.delimiter}${env.PATH || ""}`;
    if (cmake && cmake !== "cmake") env.PATH = `${path.dirname(cmake)}${path.delimiter}${env.PATH || ""}`;

    if (needsReconfigure) {
      const configureCmd = cmakeConfigureCommand({
        cmake,
        ninja,
        python,
        firmwarePath: ctx.firmwarePath,
        buildDir,
        generator,
        luaVersion: ctx.config.nodemcu.lua_version,
        luaNumberIntegral: ctx.config.nodemcu.lua_number_integral,
        luaNumber64bits: ctx.config.nodemcu.lua_number_64bits,
        verbose: ctx.verbose,
        // LFS needs luac.cross. Use AUTO (not ON) so a machine without a host C
        // compiler still configures + flashes the LFS-partitioned firmware; the
        // luac.cross then comes from the prebuilt download in deployLfsImage.
        buildHostTools: ctx.config.build.lfs_size > 0 ? "AUTO" : "OFF",
      });
      let configureResult = await this.shell.run(configureCmd.command, configureCmd.args, {
        cwd: configureCmd.cwd,
        env,
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

    // The bundled gcc spawns its assembler/linker ("as", "ld", ...) by bare
    // name during the compile, so the toolchain bin dirs must be on PATH or the
    // build dies with "gcc: error: CreateProcess: No such file or directory".
    // gcc's own relocatable search does not reliably find them on a clean
    // machine. The toolchain is fetched during configure, so glob for it now
    // (works on a first-ever run too) and prepend before building.
    const buildEnv = { ...env };
    const tcDirs = toolchainBinDirs(ctx.firmwarePath);
    if (tcDirs.length) {
      buildEnv.PATH = `${tcDirs.join(path.delimiter)}${path.delimiter}${buildEnv.PATH || ""}`;
    }

    // When LFS is enabled the build also produces the host tools (luac.cross,
    // spiffsimg). These compile with the *host* gcc, which spawns `as`/`ld` by
    // bare name; if the xtensa toolchain bin dirs are on PATH (they must be for
    // the firmware ExternalProject) the host compile grabs the xtensa assembler
    // and dies with "as: unrecognized option '--64'". So build the host-tool
    // targets first with the host-clean `env`; the later firmware build then
    // finds them up to date and never reinvokes `as` for them.
    if (ctx.config.build.lfs_size > 0) {
      for (const target of ["luac.cross", "spiffsimg"]) {
        const hostToolCmd = cmakeBuildCommand({ cmake, buildDir, parallel: ctx.parallel, jobCount: ctx.jobCount, verbose: ctx.verbose, target });
        // Tolerate failure/absence here (e.g. host compiler disabled): the main
        // build below is the real gate and will surface genuine errors.
        const toolResult = await this.shell.run(hostToolCmd.command, hostToolCmd.args, {
          cwd: hostToolCmd.cwd,
          env,
          onStdout: ctx.onLog,
          onStderr: ctx.onStderr,
          signal: ctx.signal,
        });
        // When the host compiler is present, this just (re)built luac.cross for
        // the configured flavour. Record it so deployLfsImage doesn't mistake a
        // freshly-built binary for a stale prebuilt and re-download. On a
        // flavour switch the reconfigure above forces a real rebuild, so the
        // marker tracks the current flavour. Skip on failure (host compiler
        // disabled) — the binary, if any, came from a prebuilt and keeps its
        // own marker.
        if (target === "luac.cross" && toolResult.exitCode === 0) {
          const luac = luacCrossPath(ctx.firmwarePath);
          if (fs.existsSync(luac)) {
            await writeInstalledLuacFlavour(luac, luacFlavour(ctx.config));
          }
        }
      }
    }

    // Build the firmware + flash image via the `build_all` target rather than the
    // default `all`. `all` also (re)compiles the host tools (luac.cross,
    // spiffsimg) under the xtensa-augmented PATH — and the firmware-rebuild mtime
    // bump above touches app/modules/*.c, which are shared with luac.cross, so
    // `all` would rebuild those host-tool objects with the wrong assembler
    // ("as: unrecognized option '--64'"). `build_all` depends only on the bin
    // image → firmware, leaving the host tools to the LFS-only pre-build above.
    const buildCmd = cmakeBuildCommand({
      cmake,
      buildDir,
      parallel: ctx.parallel,
      jobCount: ctx.jobCount,
      verbose: ctx.verbose,
      target: "build_all",
    });
    const buildResult = await this.shell.run(buildCmd.command, buildCmd.args, {
      cwd: buildCmd.cwd,
      env: buildEnv,
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

  /**
   * True when the configured Lua flavour differs from what the existing
   * CMakeCache.txt was generated with. Reads the cached -D values directly so a
   * `lua_version` (or number-mode) switch forces a reconfigure + rebuild.
   */
  private luaFlavourChanged(buildDir: string, config: NodemcuConfig): boolean {
    const cache = path.join(buildDir, "CMakeCache.txt");
    let text = "";
    try { text = fs.readFileSync(cache, "utf-8"); } catch { return false; }
    const cachedVar = (name: string): string | null => {
      const m = new RegExp(`^${name}(?::[^=]*)?=(.*)$`, "m").exec(text);
      return m ? m[1].trim() : null;
    };
    const cachedLua = cachedVar("LUA");
    if (cachedLua !== null && cachedLua !== config.nodemcu.lua_version) return true;
    const boolOn = (v: string | null): boolean => v === "ON" || v === "TRUE" || v === "1";
    // These are only set when ON, so only treat a true→cached-true mismatch as a change.
    const cachedIntegral = cachedVar("LUA_NUMBER_INTEGRAL");
    if (cachedIntegral !== null && boolOn(cachedIntegral) !== config.nodemcu.lua_number_integral) return true;
    const cached64 = cachedVar("LUA_NUMBER_64BITS");
    if (cached64 !== null && boolOn(cached64) !== config.nodemcu.lua_number_64bits) return true;
    return false;
  }

  private binPaths(firmwarePath: string): { bin0: string; bin1: string } {
    const dir = binOutput(firmwarePath);
    return { bin0: `${dir}/0x00000.bin`, bin1: `${dir}/0x10000.bin` };
  }
}
