/**
 * Integration test for the prebuilt `luac.cross` flow.
 *
 * Spins up a tiny local HTTP server that serves a real, working prebuilt
 * archive (a Lua 5.3 `luac.cross` we build right here from the project
 * firmware), then calls `resolvePrebuiltLuacCross` + `installPrebuiltLuacCross`
 * end-to-end. Verifies the binary lands in the firmware build path AND that
 * the resulting binary can compile a sample Lua source into a valid flash
 * image. This is the same sequence the extension's `deployLfsImage` runs
 * when the user has no host C compiler.
 *
 * Skipped unless `NODEMCU_VSCODE_LFS_FIRMWARE_PATH` points at a usable
 * firmware checkout (or `NODEMCU_VSCODE_INTEGRATION_LFS=1`). The build step
 * takes a couple of minutes on a cold cache, so the heavy lifting is gated
 * to keep the default `npm test` green.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as child_process from "node:child_process";
import { resolvePrebuiltLuacCross, installPrebuiltLuacCross, prebuiltCachePath, DEFAULT_PREBUILT_RELEASE } from "../../src/firmware/prebuiltLuacCross";
import { defaultConfig, type NodemcuConfig } from "../../src/config/nodemcuIni";
import { luacCrossPath } from "../../src/util/paths";

const ENABLED = process.env.NODEMCU_VSCODE_INTEGRATION_LFS === "1";
const describe_ = ENABLED ? describe : describe.skip;
const FIRM = process.env.NODEMCU_VSCODE_LFS_FIRMWARE_PATH || "";

describe_("prebuilt luac.cross integration", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpRoot: string;
  let storageRoot: string;
  let builtLuacPath: string;
  let archivePath: string;

  beforeAll(async () => {
    if (!FIRM || !fs.existsSync(FIRM)) {
      throw new Error(`Set NODEMCU_VSCODE_LFS_FIRMWARE_PATH to a firmware checkout. Got: ${FIRM || "(empty)"}`);
    }
    if (!fs.existsSync(path.join(FIRM, "CMakeLists.txt"))) {
      throw new Error(`Not a firmware root: ${FIRM}`);
    }
    const which = (cmd: string) => child_process.spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf-8" });
    if (which("cmake").status !== 0) throw new Error("cmake required to build a real luac.cross for this test");
    if (which("cc").status !== 0 && which("gcc").status !== 0) throw new Error("host C compiler required to build a real luac.cross");

    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "prebuilt-int-"));
    storageRoot = path.join(tmpRoot, "storage");
    await fsp.mkdir(storageRoot, { recursive: true });

    // Build a real lua53 luac.cross into a scratch dir (don't pollute the
    // project's build dir — we want a clean install of the prebuilt into it).
    const buildDir = path.join(tmpRoot, "build");
    const args = [
      "-S", FIRM,
      "-B", buildDir,
      "-G", process.platform === "win32" ? "NMake Makefiles" : "Unix Makefiles",
      "-DLUA=53",
      "-DBUILD_HOST_TOOLS=ON",
    ];
    const cfg = child_process.spawnSync("cmake", args, { encoding: "utf-8" });
    if (cfg.status !== 0) {
      throw new Error(`cmake configure failed:\n${cfg.stdout}\n${cfg.stderr}`);
    }
    const bld = child_process.spawnSync("cmake", ["--build", buildDir, "--target", "luac.cross", "-j", String(os.cpus().length)], { encoding: "utf-8" });
    if (bld.status !== 0) {
      throw new Error(`luac.cross build failed:\n${bld.stdout}\n${bld.stderr}`);
    }
    const exe = process.platform === "win32" ? "luac.cross.exe" : "luac.cross";
    builtLuacPath = path.join(buildDir, "tools", "luac_cross", exe);
    expect(fs.existsSync(builtLuacPath), `luac.cross missing at ${builtLuacPath}`).toBe(true);

    // Wrap it in a tar.gz that matches the prebuilt asset name.
    archivePath = path.join(tmpRoot, "luac-cross-v3.1.0-lua53-linux-x64.tar.gz");
    child_process.spawnSync("tar", ["-czf", archivePath, "-C", path.dirname(builtLuacPath), "luac.cross"], { stdio: "pipe" });
    expect(fs.existsSync(archivePath)).toBe(true);

    // Stand up a tiny HTTP server that serves the archive at the expected path.
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      if (url.endsWith("/" + path.basename(archivePath))) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        fs.createReadStream(archivePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 600_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("downloads, verifies, installs, and uses the prebuilt luac.cross to compile a flash image", async () => {
    const cfg: NodemcuConfig = defaultConfig();
    cfg.nodemcu.lua_version = "53";
    cfg.nodemcu.lua_number_integral = false;
    cfg.nodemcu.lua_number_64bits = false;

    // 1. Resolve against our local "release" (downloadBase). Simulates the
    //    user's first run with no host C compiler.
    const result = await resolvePrebuiltLuacCross(cfg, {
      storageRoot,
      release: DEFAULT_PREBUILT_RELEASE,
      downloadBase: baseUrl,
      onProgress: (m) => console.log("[prebuilt-int]", m),
    });
    expect(result, "expected a successful resolve").not.toBeNull();
    if (!result) return;
    expect(result.flavour).toBe("lua53");
    expect(result.cachedPath).toBe(
      prebuiltCachePath(storageRoot, "v3.1.0", { platform: "linux", arch: "x64" }, "lua53", "luac.cross"),
    );

    // 2. Install into a scratch firmware build dir; mimic what the extension
    //    does to feed `luacCrossPath(firmwarePath)` callers.
    const fakeFirmware = path.join(tmpRoot, "firmware");
    fs.mkdirSync(path.join(fakeFirmware, "build", "tools", "luac_cross"), { recursive: true });
    const dest = await installPrebuiltLuacCross(result, fakeFirmware);
    expect(dest).toBe(luacCrossPath(fakeFirmware));
    expect(fs.existsSync(dest)).toBe(true);

    // 3. Exercise the installed binary directly: produce a flash image from a
    //    sample Lua source. If the binary is corrupt or the wrong flavour,
    //    this will fail with a non-zero exit (and a small/empty image).
    const src = path.join(tmpRoot, "hello.lua");
    fs.writeFileSync(src, `local M={} function M.ping() return "pong-from-prebuilt" end return M\n`);
    const img = path.join(tmpRoot, "lfs.img");
    const r = child_process.spawnSync(dest, ["-f", "-m", "4096", "-o", img, src], { encoding: "utf-8" });
    expect(r.status, `luac.cross -f: ${r.stderr}`).toBe(0);
    expect(fs.existsSync(img)).toBe(true);
    expect(fs.statSync(img).size).toBeGreaterThan(0);

    // 4. Second resolve should be a cache hit (no second HTTP request).
    let hits = 0;
    const trackingServer = http.createServer((req, res) => {
      hits++;
      const url = req.url ?? "";
      if (url.endsWith("/" + path.basename(archivePath))) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        fs.createReadStream(archivePath).pipe(res);
      } else { res.writeHead(404); res.end(); }
    });
    const ta = await new Promise<{ port: number }>((resolve) => {
      trackingServer.listen(0, "127.0.0.1", () => {
        const a = trackingServer.address() as { port: number };
        resolve(a);
      });
    });
    const second = await resolvePrebuiltLuacCross(cfg, {
      storageRoot,
      release: DEFAULT_PREBUILT_RELEASE,
      downloadBase: `http://127.0.0.1:${ta.port}`,
    });
    trackingServer.close();
    expect(second).not.toBeNull();
    expect(hits, "second resolve should be a cache hit (zero HTTP requests)").toBe(0);
  }, 120_000);
});
