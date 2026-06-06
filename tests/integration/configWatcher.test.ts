import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ConfigWatcher } from "../../src/config/configWatcher";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nodemcu-vscode-cfg-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ConfigWatcher", () => {
  it("loads the current config on start", () => {
    const iniPath = path.join(tmp, "nodemcu.ini");
    fs.writeFileSync(iniPath, "[nodemcu]\nfirmware_path = /foo\nport = /dev/ttyUSB0\n");
    const w = new ConfigWatcher(iniPath);
    w.start();
    const c = w.current();
    expect(c).not.toBeNull();
    expect(c?.nodemcu.firmware_path).toBe("/foo");
    expect(c?.nodemcu.port).toBe("/dev/ttyUSB0");
    w.stop();
  });

  it("notifies listeners on change", async () => {
    const iniPath = path.join(tmp, "nodemcu.ini");
    fs.writeFileSync(iniPath, "[nodemcu]\nfirmware_path = /foo\n");
    const w = new ConfigWatcher(iniPath);
    let notified = 0;
    let lastPort: string | undefined;
    w.onChange((c) => {
      notified++;
      lastPort = c.nodemcu.port;
    });
    w.start();
    fs.writeFileSync(iniPath, "[nodemcu]\nfirmware_path = /foo\nport = /dev/ttyACM0\n");
    await new Promise((r) => setTimeout(r, 350));
    expect(notified).toBeGreaterThan(0);
    expect(lastPort).toBe("/dev/ttyACM0");
    w.stop();
  });

  it("debounces rapid changes", async () => {
    const iniPath = path.join(tmp, "nodemcu.ini");
    fs.writeFileSync(iniPath, "[nodemcu]\nfirmware_path = /foo\n");
    const w = new ConfigWatcher(iniPath);
    let notified = 0;
    w.onChange(() => notified++);
    w.start();
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(iniPath, `[nodemcu]\nfirmware_path = /foo\nport = /p${i}\n`);
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 350));
    expect(notified).toBeLessThanOrEqual(2);
    w.stop();
  });
});
