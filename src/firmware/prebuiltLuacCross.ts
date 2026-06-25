import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { MANAGED_FIRMWARE_TAG } from "./managedFirmware";
import type { NodemcuConfig } from "../config/nodemcuIni";
import { luacCrossPath } from "../util/paths";

/**
 * Pre-built `luac.cross` host tool.
 *
 * `luac.cross` is the cross-compiler that turns project Lua into the LFS flash
 * image. The firmware CMake builds it as a host tool only when a host C
 * compiler is on PATH at configure time — which is a real barrier for users
 * who only need the cross-compiler (not the xtensa firmware toolchain).
 *
 * This module ships pre-built binaries for the three valid Lua flavours
 * (lua51, lua51-int, lua53) on the three common platforms × two architectures
 * (linux/darwin/win32 × x64/arm64). The binaries are attached to the
 * extension's GitHub Releases and fetched on demand into the same
 * globalStorage cache the managed firmware uses. Falls back gracefully when
 * no prebuilt is available (the user can still build locally).
 *
 * The release asset name encodes the firmware tag + Lua flavour + target
 * platform/arch, so a `luac.cross` always matches the firmware bytecode it
 * was built against.
 */

export type LuacFlavour = "lua51" | "lua51-int" | "lua53";

export interface LuacFlavourInfo {
  flavour: LuacFlavour;
  /** Binary basename within the asset archive. */
  binaryName: string;
}

/**
 * Map the user's Lua configuration to the matching prebuilt flavour. The
 * extension's three valid LFS-compatible configurations are:
 *   - lua51          (Lua 5.1.4, double numbers)
 *   - lua51-int      (Lua 5.1.4, integer numbers, `-DLUA_NUMBER_INTEGRAL=ON`)
 *   - lua53          (Lua 5.3.6, double numbers — `-DLUA_NUMBER_INTEGRAL` is
 *                     not valid for 5.3 and the firmware rejects 5.3 images
 *                     built with `-DLUA_NUMBER_64BITS=ON`, so the 5.3 path
 *                     is just `lua53`)
 */
export function luacFlavour(config: NodemcuConfig): LuacFlavour {
  if (config.nodemcu.lua_version === "51") {
    return config.nodemcu.lua_number_integral ? "lua51-int" : "lua51";
  }
  return "lua53";
}

/**
 * The on-disk binary name for a flavour on a given host target. The
 * `luac-cross-release` workflow zips the host tool with the platform-native
 * name (i.e. `luac.cross.exe` on Windows, `luac.cross` on POSIX), so the
 * extension must look for the right one — otherwise the extraction "succeeds"
 * but the cached-file check fails and we report "Prebuilt archive did not
 * contain luac.cross." on Windows.
 */
export function luacFlavourInfo(flavour: LuacFlavour, target: PrebuiltTarget): LuacFlavourInfo {
  const ext = target.platform === "win32" ? ".exe" : "";
  if (flavour === "lua51-int") return { flavour, binaryName: `luac.cross.int${ext}` };
  return { flavour, binaryName: `luac.cross${ext}` };
}

export type PrebuiltPlatform = "linux" | "darwin" | "win32";

export interface PrebuiltTarget {
  platform: PrebuiltPlatform;
  arch: "x64" | "arm64";
}

export function currentPrebuiltTarget(): PrebuiltTarget {
  const platform = ((): PrebuiltPlatform => {
    if (os.platform() === "linux") return "linux";
    if (os.platform() === "darwin") return "darwin";
    if (os.platform() === "win32") return "win32";
    throw new Error(`Unsupported platform for prebuilt luac.cross: ${os.platform()}`);
  })();
  const arch = ((): "x64" | "arm64" => {
    if (os.arch() === "x64" || os.arch() === "ia32") return "x64";
    if (os.arch() === "arm64") return "arm64";
    throw new Error(`Unsupported architecture for prebuilt luac.cross: ${os.arch()}`);
  })();
  return { platform, arch };
}

export interface PrebuiltReleaseConfig {
  /** GitHub owner/repo hosting the release assets. */
  repo: { owner: string; repo: string };
  /**
   * Tag of the GitHub release that carries the prebuilt assets. This is
   * the URL path the assets are downloaded from and is independent of the
   * firmware tag (an extension release like v0.3.1 may host assets built
   * against firmware v3.1.2).
   */
  releaseTag: string;
  /**
   * Firmware tag the prebuilt binaries were built against. Encoded into
   * the asset filename (`luac-cross-<firmwareTag>-...`) and used as the
   * cache key, so the cached binary can never drift from the firmware
   * bytecode it must compile.
   */
  firmwareTag: string;
}

export const DEFAULT_PREBUILT_RELEASE: PrebuiltReleaseConfig = {
  repo: { owner: "caiohamamura", repo: "nodemcu-firmware" },
  releaseTag: MANAGED_FIRMWARE_TAG,
  firmwareTag: MANAGED_FIRMWARE_TAG,
};

/**
 * Asset name for a prebuilt `luac.cross`:
 *   `luac-cross-<firmwareTag>-<flavour>-<platform>-<arch>.<ext>`
 * The extension extracts the binary into the same path the local build would
 * write to, so callers can use `luacCrossPath(firmwarePath)` unchanged.
 */
export function prebuiltAssetName(target: PrebuiltTarget, flavour: LuacFlavour, firmwareTag: string): string {
  const ext = target.platform === "win32" ? "zip" : "tar.gz";
  return `luac-cross-${firmwareTag}-${flavour}-${target.platform}-${target.arch}.${ext}`;
}

export interface PrebuiltLuacCrossOptions {
  storageRoot: string;
  release?: PrebuiltReleaseConfig;
  /** Override the asset download root (tests use this to point at a fixture). */
  downloadBase?: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface PrebuiltLuacCrossResult {
  flavour: LuacFlavour;
  target: PrebuiltTarget;
  /** Absolute path to the `luac.cross` binary on disk. */
  binaryPath: string;
  /** Absolute path to the cached, versioned copy. */
  cachedPath: string;
}

/** Cached prebuilt location: `<storageRoot>/luac-cross/<tag>/<flavour>/<platform>-<arch>/<binary>`. */
export function prebuiltCachePath(
  storageRoot: string,
  firmwareTag: string,
  target: PrebuiltTarget,
  flavour: LuacFlavour,
  binaryName: string,
): string {
  return path.join(
    storageRoot,
    "luac-cross",
    firmwareTag,
    flavour,
    `${target.platform}-${target.arch}`,
    binaryName,
  );
}

async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

/**
 * Resolve a prebuilt `luac.cross` for the given Lua flavour + host target.
 *
 * 1. If the cache already has the right binary and it runs, return it.
 * 2. Otherwise look up the matching asset on the configured GitHub release
 *    and download it. On Windows the archive is a zip; on POSIX it's a tar.gz.
 * 3. Extract the binary to the cache and chmod +x on POSIX.
 * 4. Run it (`-v`) to confirm the flavour matches the asset name. (A cache
 *    miss shouldn't ever produce a wrong-flavour binary, but the explicit
 *    check makes the failure mode readable.)
 *
 * Throws on any network/parse/extract error. Callers should fall back to
 * "build locally" when this returns no result.
 */
export async function resolvePrebuiltLuacCross(
  config: NodemcuConfig,
  opts: PrebuiltLuacCrossOptions,
): Promise<PrebuiltLuacCrossResult | null> {
  const target = currentPrebuiltTarget();
  const flavour = luacFlavour(config);
  const { binaryName } = luacFlavourInfo(flavour, target);
  const release = opts.release ?? DEFAULT_PREBUILT_RELEASE;
  const downloadBase = opts.downloadBase ?? "https://github.com";
  // The firmware tag is what the prebuilt binary was built against and is
  // what goes into the asset filename + cache key. The release tag is the
  // URL path the assets are downloaded from. They differ on purpose: the
  // extension ships its own release tag (e.g. v0.3.1) that hosts assets
  // built for a different firmware fork tag (e.g. v3.1.2).
  const firmwareTag = release.firmwareTag;
  const cachedPath = prebuiltCachePath(opts.storageRoot, firmwareTag, target, flavour, binaryName);

  if (await exists(cachedPath)) {
    if (await verifyLuacBinary(cachedPath, flavour, target)) {
      return { flavour, target, binaryPath: cachedPath, cachedPath };
    }
    opts.onProgress?.(`Cached luac.cross failed verification; re-downloading.`);
    await fsp.rm(cachedPath, { force: true });
  }

  const assetName = prebuiltAssetName(target, flavour, firmwareTag);
  opts.onProgress?.(`Looking up prebuilt luac.cross (${assetName})`);

  const downloadUrl = `${downloadBase}/${release.repo.owner}/${release.repo.repo}/releases/download/${encodeURIComponent(release.releaseTag)}/${assetName}`;
  const archiveDir = path.join(path.dirname(cachedPath), "..", ".download");
  await ensureDir(archiveDir);
  const archivePath = path.join(archiveDir, assetName);

  try {
    await downloadFile(downloadUrl, archivePath, opts.signal);
  } catch (err) {
    opts.onProgress?.(`Prebuilt download failed (${err instanceof Error ? err.message : String(err)}); will fall back to local build.`);
    await fsp.rm(archivePath, { force: true });
    return null;
  }

  if (!(await exists(archivePath))) {
    return null;
  }

  try {
    await extractArchive(archivePath, target, path.dirname(cachedPath));
    if (!(await exists(cachedPath))) {
      opts.onProgress?.(`Prebuilt archive did not contain ${binaryName}.`);
      return null;
    }
    if (target.platform !== "win32") {
      await fsp.chmod(cachedPath, 0o755);
    }
    if (!(await verifyLuacBinary(cachedPath, flavour, target))) {
      opts.onProgress?.(`Prebuilt luac.cross failed verification.`);
      await fsp.rm(cachedPath, { force: true });
      return null;
    }
    return { flavour, target, binaryPath: cachedPath, cachedPath };
  } catch (err) {
    opts.onProgress?.(`Prebuilt extraction failed (${err instanceof Error ? err.message : String(err)}).`);
    await fsp.rm(cachedPath, { force: true });
    return null;
  } finally {
    await fsp.rm(archivePath, { force: true });
  }
}

/**
 * Copy the prebuilt `luac.cross` to the firmware's expected build path
 * (i.e. where `BuildManager` would have placed it). Returns the installed
 * path. The prebuilt cache stays intact so the binary is reusable across
 * builds; the copy is idempotent — re-runs overwrite the destination.
 */
export async function installPrebuiltLuacCross(
  prebuilt: PrebuiltLuacCrossResult,
  firmwarePath: string,
): Promise<string> {
  const dest = luacCrossPath(firmwarePath);
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(prebuilt.cachedPath, dest);
  if (process.platform !== "win32") {
    await fsp.chmod(dest, 0o755);
  }
  return dest;
}

async function downloadFile(url: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }
  const fileStream = fs.createWriteStream(outputPath);
  await finished(Readable.fromWeb(response.body as any).pipe(fileStream));
}

async function extractArchive(archivePath: string, target: PrebuiltTarget, destDir: string): Promise<void> {
  await ensureDir(destDir);
  const isZip = archivePath.toLowerCase().endsWith(".zip");
  if (!isZip) {
    // .tar.gz / .tgz: defer to the system `tar`. Available on every modern
    // Windows (10+/Server 2019+), macOS, and Linux.
    child_process.execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "pipe" });
    return;
  }
  // .zip: try the system `tar` first (handles zip out of the box on modern
  // Windows + macOS + bsdtar Linux), then fall back to the pure-JS
  // `extract-zip` for environments without it (older Linuxes, minimal Alpine).
  try {
    child_process.execFileSync("tar", ["-xf", archivePath, "-C", destDir], { stdio: "pipe" });
  } catch {
    const extractZip = (await import("extract-zip")).default;
    await extractZip(archivePath, { dir: destDir });
  }
  // The `target` parameter is intentionally kept on the signature so the
  // caller code reads as "extract for the given target" even though the
  // extraction itself is now extension-driven.
  void target;
}

/**
 * Run the cached binary and verify (a) it executes and (b) the printed Lua
 * version matches the requested flavour. Catches wrong-flavour archives
 * (e.g. someone attached a lua53 binary under a lua51 name) before the
 * firmware ever sees them.
 */
async function verifyLuacBinary(
  binaryPath: string,
  flavour: LuacFlavour,
  target: PrebuiltTarget,
): Promise<boolean> {
  try {
    const out = child_process.execFileSync(binaryPath, ["-v"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      windowsHide: true,
    }).toString("utf-8");
    const expected: Record<LuacFlavour, RegExp> = {
      "lua51": /Lua 5\.1\b/,
      "lua51-int": /Lua 5\.1\b/,
      "lua53": /Lua 5\.3\b/,
    };
    return expected[flavour].test(out);
  } catch (err) {
    if (target.platform === "win32") {
      // On Windows a freshly-downloaded binary can be blocked by SmartScreen
      // or an unset PATHEXT quirk; the test only runs from the cache so this
      // is the right place to surface it without raising.
      return false;
    }
    return false;
  }
}
