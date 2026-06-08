import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { localFilesForSrc, planMirrorSync } from "../../src/upload/srcMirror";

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
});
