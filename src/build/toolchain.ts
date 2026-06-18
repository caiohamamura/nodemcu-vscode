import { Shell, type CommandSpec, formatCommand } from "../util/shell";

export interface ToolchainInfo {
  cmake: string;
  python: string;
  make?: string;
  ninja?: string;
  hostCC?: string;
  generator: "Ninja" | "Unix Makefiles" | "NMake Makefiles" | "MinGW Makefiles" | "MSYS Makefiles" | "Unknown";
}

// Candidate host C compiler names, in preference order. The managed firmware's
// CMake builds the optional host tools (luac.cross, spiffsimg) when any of these
// is found at configure time (BUILD_HOST_TOOLS=AUTO -> check_language(C)).
const HOST_CC_CANDIDATES = ["cc", "gcc", "clang"];

/**
 * Locate a host C compiler used to build `luac.cross` (the LFS image compiler).
 * Non-fatal: returns the first compiler found on PATH, or null. Used to gate the
 * opt-in LFS feature without forcing a full cmake-bearing toolchain probe.
 */
export async function detectHostCompiler(shell: Shell): Promise<string | null> {
  for (const candidate of HOST_CC_CANDIDATES) {
    const found = await shell.which(candidate);
    if (found) return found;
  }
  return null;
}

export class ToolchainLocator {
  constructor(
    private shell: Shell,
    private preferredPython?: string,
    private preferredCmake?: string,
    private preferredNinja?: string,
  ) {}

  async locate(): Promise<ToolchainInfo> {
    const cmake = this.preferredCmake || await this.shell.which("cmake");
    if (!cmake) {
      throw new Error("cmake not found on PATH. Install CMake 3.24+ and ensure it is on PATH.");
    }
    const python = this.preferredPython || await this.locatePython();
    const ninja = this.preferredNinja || await this.shell.which("ninja");
    const make = await this.shell.which("make");
    const generator = await this.detectGenerator(ninja, make);
    if (!python) throw new Error("Python not found. Install Python 3 and ensure it is on PATH.");
    const hostCC = await detectHostCompiler(this.shell);
    return { cmake, python, ninja: ninja ?? undefined, make: make ?? undefined, hostCC: hostCC ?? undefined, generator };
  }

  private async locatePython(): Promise<string> {
    for (const candidate of ["python", "python3", "py"]) {
      const p = await this.shell.which(candidate);
      if (p) {
        try {
          const r = await this.shell.run(candidate, ["--version"]);
          if (r.exitCode === 0) return p;
        } catch {
          // try next
        }
      }
    }
    throw new Error("python not found on PATH. Install Python 3 and ensure 'python' or 'python3' is on PATH.");
  }

  private async detectGenerator(ninja: string | null, make: string | null): Promise<ToolchainInfo["generator"]> {
    if (ninja) return "Ninja";
    if (process.platform === "win32") {
      if (make) return "MSYS Makefiles";
      const nmake = await this.shell.which("nmake");
      if (nmake) return "NMake Makefiles";
      const mingw = await this.shell.which("mingw32-make");
      if (mingw) return "MinGW Makefiles";
      return "Unknown";
    }
    if (make) return "Unix Makefiles";
    return "Unknown";
  }
}

export function cmakeConfigureCommand(opts: {
  cmake?: string;
  ninja?: string;
  python?: string;
  firmwarePath: string;
  buildDir: string;
  generator: ToolchainInfo["generator"];
  luaVersion: "51" | "53";
  luaNumberIntegral: boolean;
  luaNumber64bits: boolean;
  verbose: boolean;
  /** Build the optional host tools (luac.cross, spiffsimg). Needed for LFS. */
  buildHostTools?: boolean;
}): CommandSpec {
  const args: string[] = [
    "-S", opts.firmwarePath,
    "-B", opts.buildDir,
    "-G", opts.generator,
    `-DLUA=${opts.luaVersion}`,
    // Only build the host tools when LFS needs luac.cross. Building them as part
    // of a normal firmware build risks the host compiler picking up the xtensa
    // assembler from PATH ("as: unrecognized option '--64'").
    `-DBUILD_HOST_TOOLS=${opts.buildHostTools ? "ON" : "OFF"}`,
  ];
  if (opts.generator === "Ninja" && opts.ninja) {
    args.push(`-DCMAKE_MAKE_PROGRAM=${opts.ninja}`);
  }
  // The firmware does `find_package(Python3 ... REQUIRED)`. CMake's own
  // interpreter search is unreliable across machines (it misses newer Python
  // versions and trips over the Windows Store `python3` alias), so pin the
  // interpreter we already resolved instead of leaving it to chance.
  if (opts.python) {
    args.push(`-DPython3_EXECUTABLE=${opts.python}`);
  }
  if (opts.luaNumberIntegral) args.push("-DLUA_NUMBER_INTEGRAL=ON");
  if (opts.luaNumber64bits) args.push("-DLUA_NUMBER_64BITS=ON");
  if (opts.verbose) args.push("-DCMAKE_VERBOSE_MAKEFILE=ON");
  return { command: opts.cmake || "cmake", args, cwd: opts.firmwarePath };
}

export function cmakeBuildCommand(opts: {
  cmake?: string;
  buildDir: string;
  parallel: boolean;
  jobCount: number;
  verbose: boolean;
  target?: string;
}): CommandSpec {
  const args = ["--build", opts.buildDir];
  if (opts.target) args.push("--target", opts.target);
  if (opts.parallel && opts.jobCount > 0) {
    args.push("-j", String(opts.jobCount));
  }
  if (opts.verbose) args.push("-v");
  return { command: opts.cmake || "cmake", args, cwd: opts.buildDir };
}

export function normalizeFlashSize(value: string): string {
  if (!value) return value;
  const v = value.trim();
  if (/^(detect|keep)$/i.test(v)) return v;
  const m = v.match(/^(\d+)\s*(k|kb|m|mb|g|gb)$/i);
  if (!m) return v;
  const n = m[1];
  const unit = m[2].toUpperCase();
  const full = unit.length === 1 ? unit + "B" : unit;
  return `${n}${full}`;
}

export function esptoolFlashCommand(opts: {
  python: string;
  esptool: string;
  port: string;
  baud: number;
  flashMode: string;
  flashFreq: string;
  flashSize: string;
  bin0: string;
  bin1: string;
  extraFiles: Array<{ path: string; offset: string }>;
}): CommandSpec {
  const args: string[] = [
    opts.esptool,
    "--port", opts.port,
    "--baud", String(opts.baud),
    "write_flash",
    "--flash_mode", opts.flashMode,
    "--flash_freq", opts.flashFreq,
    "--flash_size", normalizeFlashSize(opts.flashSize),
    "0x00000", opts.bin0,
    "0x10000", opts.bin1,
  ];
  for (const f of opts.extraFiles) {
    args.push(f.offset, f.path);
  }
  return { command: opts.python, args };
}

export { formatCommand };
