import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getFilesRecursively, localFilesForSrc, planMirrorSync } from "../../src/upload/srcMirror";

function normalize(files: string[]): string[] {
  return files.map((f) => f.replace(/\\/g, "/")).sort();
}

describe("getFilesRecursively", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-src-recursive-"));
    fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("returns all files in a directory tree", () => {
    fs.writeFileSync(path.join(tmp, "src", "a.lua"), "");
    fs.mkdirSync(path.join(tmp, "src", "sub"));
    fs.writeFileSync(path.join(tmp, "src", "sub", "b.lua"), "");
    const files = getFilesRecursively(path.join(tmp, "src")).map((f) => path.relative(path.join(tmp, "src"), f));
    expect(normalize(files)).toEqual(["a.lua", "sub/b.lua"]);
  });

  it("returns empty array for non-existent directory", () => {
    expect(getFilesRecursively(path.join(tmp, "nonexistent"))).toEqual([]);
  });

  it("returns empty array for empty directory", () => {
    expect(getFilesRecursively(path.join(tmp, "src"))).toEqual([]);
  });

  it("skips .git, node_modules, .vscode directories", () => {
    fs.writeFileSync(path.join(tmp, "src", "main.lua"), "");
    fs.mkdirSync(path.join(tmp, "src", ".git"));
    fs.mkdirSync(path.join(tmp, "src", "node_modules"));
    fs.mkdirSync(path.join(tmp, "src", ".vscode"));
    fs.writeFileSync(path.join(tmp, "src", ".git", "HEAD"), "");
    fs.writeFileSync(path.join(tmp, "src", "node_modules", "pkg.js"), "");
    fs.writeFileSync(path.join(tmp, "src", ".vscode", "settings.json"), "");
    const files = getFilesRecursively(path.join(tmp, "src")).map((f) => path.relative(path.join(tmp, "src"), f));
    expect(files).toEqual(["main.lua"]);
  });

  it("preserves nested non-ignored directories", () => {
    fs.mkdirSync(path.join(tmp, "src", "lib"));
    fs.mkdirSync(path.join(tmp, "src", "lib", "net"));
    fs.writeFileSync(path.join(tmp, "src", "init.lua"), "");
    fs.writeFileSync(path.join(tmp, "src", "lib", "wifi.lua"), "");
    fs.writeFileSync(path.join(tmp, "src", "lib", "net", "http.lua"), "");
    const files = getFilesRecursively(path.join(tmp, "src")).map((f) => path.relative(path.join(tmp, "src"), f));
    expect(normalize(files)).toEqual(["init.lua", "lib/net/http.lua", "lib/wifi.lua"]);
  });
});

describe("src mirror planning", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-src-mirror-"));
    fs.mkdirSync(path.join(tmp, "lib"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "init.lua"), "print('init')\n");
    fs.writeFileSync(path.join(tmp, "lib", "wifi.lua"), "return {}\n");
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("maps local files to remote names relative to src", () => {
    expect(localFilesForSrc(tmp)).toEqual(expect.arrayContaining([
      { localPath: path.join(tmp, "init.lua"), remoteName: "init.lua" },
      { localPath: path.join(tmp, "lib", "wifi.lua"), remoteName: "lib/wifi.lua" },
    ]));
  });

  it("uploads local files and removes remote files absent from src", () => {
    const plan = planMirrorSync({
      srcDir: tmp,
      remoteFiles: [{ name: "init.lua", size: 10 }, { name: "stale.lua", size: 1 }],
      changedOnly: false,
    });
    expect(plan.upload.map((file) => file.remoteName).sort()).toEqual(["init.lua", "lib/wifi.lua"]);
    expect(plan.remove).toEqual(["stale.lua"]);
  });

  it("filters uploads by timestamps while still planning deletes", () => {
    const initPath = path.join(tmp, "init.lua");
    const wifiPath = path.join(tmp, "lib", "wifi.lua");
    const uploadTimestamps = {
      [initPath]: fs.statSync(initPath).mtimeMs + 1,
      [wifiPath]: 0,
    };
    const plan = planMirrorSync({
      srcDir: tmp,
      remoteFiles: [{ name: "stale.lua", size: 1 }],
      uploadTimestamps,
      changedOnly: true,
    });
    expect(plan.upload.map((file) => file.remoteName)).toEqual(["lib/wifi.lua"]);
    expect(plan.remove).toEqual(["stale.lua"]);
  });

  it("plans nothing when local and remote are in sync", () => {
    const plan = planMirrorSync({
      srcDir: tmp,
      remoteFiles: [{ name: "init.lua", size: 10 }, { name: "lib/wifi.lua", size: 5 }],
      changedOnly: false,
    });
    expect(plan.upload).toHaveLength(2);
    expect(plan.remove).toHaveLength(0);
  });

  it("plans no deletes when remote has no extra files", () => {
    const plan = planMirrorSync({
      srcDir: tmp,
      remoteFiles: [{ name: "init.lua", size: 10 }],
      changedOnly: false,
    });
    expect(plan.remove).toEqual([]);
  });

  it("handles empty remote file list", () => {
    const plan = planMirrorSync({
      srcDir: tmp,
      remoteFiles: [],
      changedOnly: false,
    });
    expect(plan.upload).toHaveLength(2);
    expect(plan.remove).toEqual([]);
  });

  it("handles empty src directory", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-empty-"));
    try {
      const plan = planMirrorSync({
        srcDir: emptyDir,
        remoteFiles: [{ name: "stale.lua", size: 1 }],
        changedOnly: false,
      });
      expect(plan.upload).toHaveLength(0);
      expect(plan.remove).toEqual(["stale.lua"]);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("changedOnly with no uploadTimestamps uploads everything", () => {
    const plan = planMirrorSync({
      srcDir: tmp,
      remoteFiles: [],
      changedOnly: true,
    });
    expect(plan.upload).toHaveLength(2);
  });

  it("changedOnly with all up-to-date timestamps uploads nothing", () => {
    const initPath = path.join(tmp, "init.lua");
    const wifiPath = path.join(tmp, "lib", "wifi.lua");
    const uploadTimestamps = {
      [initPath]: fs.statSync(initPath).mtimeMs,
      [wifiPath]: fs.statSync(wifiPath).mtimeMs,
    };
    const plan = planMirrorSync({
      srcDir: tmp,
      remoteFiles: [],
      uploadTimestamps,
      changedOnly: true,
    });
    expect(plan.upload).toHaveLength(0);
  });
});
