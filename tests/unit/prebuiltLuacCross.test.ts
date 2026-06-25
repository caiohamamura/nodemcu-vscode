import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import {
  luacFlavour,
  luacFlavourInfo,
  prebuiltAssetName,
  prebuiltCachePath,
  resolvePrebuiltLuacCross,
  installPrebuiltLuacCross,
  DEFAULT_PREBUILT_RELEASE,
} from "../../src/firmware/prebuiltLuacCross";
import { defaultConfig, type NodemcuConfig } from "../../src/config/nodemcuIni";

// The download/install fixtures below ship lua53 binaries, so pin the flavour
// explicitly rather than relying on the project default (which is lua51).
function cfg(): NodemcuConfig {
  const c = defaultConfig();
  return { ...c, nodemcu: { ...c.nodemcu, lua_version: "53" } };
}

function withLua(config: NodemcuConfig, lua: "51" | "53", integral: boolean): NodemcuConfig {
  return {
    ...config,
    nodemcu: { ...config.nodemcu, lua_version: lua, lua_number_integral: integral, lua_number_64bits: false },
  };
}

describe("luacFlavour", () => {
  it("lua51 + float numbers = lua51", () => {
    expect(luacFlavour(withLua(cfg(), "51", false))).toBe("lua51");
  });
  it("lua51 + integral = lua51-int", () => {
    expect(luacFlavour(withLua(cfg(), "51", true))).toBe("lua51-int");
  });
  it("lua53 = lua53 (integral is invalid for 5.3; we never produce a 5.3+int binary)", () => {
    expect(luacFlavour(withLua(cfg(), "53", false))).toBe("lua53");
  });
});

describe("luacFlavourInfo", () => {
  it("lua51 binary is luac.cross", () => {
    expect(luacFlavourInfo("lua51").binaryName).toBe("luac.cross");
  });
  it("lua51-int binary is luac.cross.int", () => {
    expect(luacFlavourInfo("lua51-int").binaryName).toBe("luac.cross.int");
  });
  it("lua53 binary is luac.cross", () => {
    expect(luacFlavourInfo("lua53").binaryName).toBe("luac.cross");
  });
});

describe("prebuiltAssetName", () => {
  it("encodes tag + flavour + target", () => {
    expect(prebuiltAssetName({ platform: "linux", arch: "x64" }, "lua53", "v3.1.2"))
      .toBe("luac-cross-v3.1.2-lua53-linux-x64.tar.gz");
  });
  it("uses zip for windows", () => {
    expect(prebuiltAssetName({ platform: "win32", arch: "x64" }, "lua51-int", "v3.1.2"))
      .toBe("luac-cross-v3.1.2-lua51-int-win32-x64.zip");
  });
  it("uses tar.gz for macOS", () => {
    expect(prebuiltAssetName({ platform: "darwin", arch: "arm64" }, "lua51", "v3.1.2"))
      .toBe("luac-cross-v3.1.2-lua51-darwin-arm64.tar.gz");
  });
});

describe("prebuiltCachePath", () => {
  it("lays out <root>/luac-cross/<tag>/<flavour>/<platform-arch>/<binary>", () => {
    const p = prebuiltCachePath("/storage", "v3.1.2", { platform: "linux", arch: "x64" }, "lua53", "luac.cross");
    expect(p).toBe(path.join("/storage", "luac-cross", "v3.1.2", "lua53", "linux-x64", "luac.cross"));
  });
});

/**
 * Stand up a tiny local HTTP server that serves a single prebuilt archive and
 * assert the resolve path downloads, extracts, and verifies it. The "binary"
 * is a shell script that prints the expected Lua version line — the
 * `verifyLuacBinary` check matches that line, just like the real one does.
 */
describe("resolvePrebuiltLuacCross", () => {
  let tmpRoot: string;
  let storageRoot: string;
  let server: http.Server;
  let baseUrl: string;
  let serverHits = 0;
  let servedAsset: string | null = null;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "prebuilt-test-"));
    storageRoot = path.join(tmpRoot, "storage");
    await fsp.mkdir(storageRoot, { recursive: true });
    serverHits = 0;
    servedAsset = null;
    server = http.createServer((req, res) => {
      serverHits++;
      const url = req.url ?? "";
      if (servedAsset && url.endsWith("/" + path.basename(servedAsset))) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(fs.readFileSync(servedAsset));
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  function makeLua53Archive(dir: string): string {
    // Build a tar.gz containing ./luac.cross that prints "Lua 5.3.6 ...".
    const stageDir = path.join(dir, "stage");
    fs.mkdirSync(stageDir, { recursive: true });
    const bin = path.join(stageDir, "luac.cross");
    fs.writeFileSync(
      bin,
      "#!/bin/sh\necho 'Lua 5.3.6  Copyright (C) 1994-2020 Lua.org, PUC-Rio'\n",
      { mode: 0o755 },
    );
    const archive = path.join(dir, "luac-cross-v3.1.2-lua53-linux-x64.tar.gz");
    child_process.spawnSync("tar", ["-czf", archive, "-C", stageDir, "luac.cross"], { stdio: "pipe" });
    return archive;
  }

  it("downloads, extracts, and caches the prebuilt on first call", async () => {
    if (process.platform === "win32") return; // tar present; not skipping here
    const archive = makeLua53Archive(tmpRoot);
    servedAsset = archive;

    const result = await resolvePrebuiltLuacCross(cfg(), {
      storageRoot,
      release: DEFAULT_PREBUILT_RELEASE,
      downloadBase: baseUrl,
      onProgress: (m) => console.log("[prebuilt]", m),
    });
    expect(result, "expected a successful resolve").not.toBeNull();
    if (!result) return;
    expect(result.flavour).toBe("lua53");
    expect(result.cachedPath).toBe(prebuiltCachePath(storageRoot, "v3.1.2", { platform: "linux", arch: "x64" }, "lua53", "luac.cross"));
    expect(fs.existsSync(result.cachedPath)).toBe(true);
    expect(fs.statSync(result.cachedPath).mode & 0o111).not.toBe(0); // executable
  });

  it("returns the cached copy without re-downloading on second call", async () => {
    if (process.platform === "win32") return;
    const archive = makeLua53Archive(tmpRoot);
    servedAsset = archive;

    const first = await resolvePrebuiltLuacCross(cfg(), { storageRoot, downloadBase: baseUrl });
    expect(first).not.toBeNull();
    const second = await resolvePrebuiltLuacCross(cfg(), { storageRoot, downloadBase: baseUrl });
    expect(second).not.toBeNull();
    expect(serverHits).toBe(1); // only the first call hit the network
  });

  it("rejects an archive whose binary advertises a wrong Lua version", async () => {
    if (process.platform === "win32") return;
    // Build an archive that looks like lua53 (per the asset name) but its
    // binary actually prints lua51 — the verify step should drop it.
    const stageDir = path.join(tmpRoot, "stage");
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, "luac.cross"), "#!/bin/sh\necho 'Lua 5.1.4'\n", { mode: 0o755 });
    const archive = path.join(tmpRoot, "luac-cross-v3.1.2-lua53-linux-x64.tar.gz");
    require("node:child_process").spawnSync("tar", ["-czf", archive, "-C", stageDir, "luac.cross"], { stdio: "pipe" });
    servedAsset = archive;

    const result = await resolvePrebuiltLuacCross(cfg(), { storageRoot, downloadBase: baseUrl });
    expect(result, "flavour mismatch should be rejected").toBeNull();
  });

  it("returns null when the download URL is unreachable", async () => {
    // Don't serve anything; the request will 404.
    const result = await resolvePrebuiltLuacCross(cfg(), { storageRoot, downloadBase: baseUrl });
    expect(result).toBeNull();
  });

  it("installPrebuiltLuacCross copies the cached binary to the firmware build path", async () => {
    if (process.platform === "win32") return;
    const archive = makeLua53Archive(tmpRoot);
    servedAsset = archive;

    const prebuilt = await resolvePrebuiltLuacCross(cfg(), { storageRoot, downloadBase: baseUrl });
    expect(prebuilt).not.toBeNull();
    if (!prebuilt) return;

    const firmwarePath = path.join(tmpRoot, "firmware");
    fs.mkdirSync(path.join(firmwarePath, "build", "tools", "luac_cross"), { recursive: true });
    const dest = await installPrebuiltLuacCross(prebuilt, firmwarePath);
    expect(dest).toBe(path.join(firmwarePath, "build", "tools", "luac_cross", "luac.cross"));
    expect(fs.existsSync(dest)).toBe(true);
    // Cached copy still exists, untouched.
    expect(fs.existsSync(prebuilt.cachedPath)).toBe(true);
  });
});

import * as child_process from "node:child_process";
