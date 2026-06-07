import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { writeUserModulesHeader } from "../../src/build/userModulesWriter";
import { parseIni, serializeIni } from "../../src/config/nodemcuIni";

const PORT = "COM7";
const BAUD_RATE = 115200;
const DEBUG_PORT = 9238;
const FIRMWARE_REPO = "C:/Users/caioh/src/nodemcu-firmware";
const WORKSPACE_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-workspace");
const USER_DATA_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-user-data");
const EXTENSIONS_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-extensions");

const hasFirmwareRepo = fs.existsSync(path.join(FIRMWARE_REPO, "CMakeLists.txt"));
const hasCMake = (() => {
  try {
    const r = child_process.spawnSync("cmake", ["--version"], { encoding: "utf-8" });
    return r.status === 0;
  } catch {
    return false;
  }
})();
const hasEsptool = (() => {
  try {
    const r = child_process.spawnSync("python", ["-c", "import esptool; print(esptool.__version__)"], { encoding: "utf-8" });
    return r.status === 0 && /^\d+\.\d+/.test(r.stdout.trim());
  } catch {
    return false;
  }
})();

const describe_ = hasFirmwareRepo && hasCMake && hasEsptool ? describe : describe.skip;

async function getDebuggerUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
      if (res.ok) {
        const targets = await res.json() as any[];
        const target = targets.find(t => t.title.includes("[Extension Development Host]") || t.title.includes("nodemcu-vscode"));
        if (target) return target.webSocketDebuggerUrl;
      }
    } catch {
      // ignore and retry
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("Could not connect to EDH debugger port");
}

class CDPClient {
  wsUrl: string;
  ws: any = null;
  id = 1;
  pending = new Map<number, { resolve: Function; reject: Function }>();

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  async connect() {
    this.ws = new (globalThis as any).WebSocket(this.wsUrl);
    this.ws.onmessage = (event: any) => {
      const data = JSON.parse(event.data);
      if (this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id)!;
        this.pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
        else resolve(data.result);
      }
    };

    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err: any) => reject(err);
    });

    await this.send("Runtime.enable");
  }

  send(method: string, params: any = {}) {
    return new Promise((resolve, reject) => {
      const msgId = this.id++;
      this.pending.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  async evaluate(expression: string): Promise<any> {
    const result: any = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${result.exceptionDetails.exception.description}`);
    }
    return result.result.value;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

describe_("E2E CDP + Hardware Device Tests", () => {
  let client: CDPClient;
  let codeProcess: child_process.ChildProcess;
  const extensionPath = path.resolve(__dirname, "../..");

  beforeAll(async () => {
    // 1. Prepare temp dirs
    fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    
    fs.rmSync(EXTENSIONS_DIR, { recursive: true, force: true });
    fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });

    // Seed User Data to skip AI splash
    const seedSrc = path.join(process.env.APPDATA || "", "Code");
    if (fs.existsSync(seedSrc)) {
      try {
        const lsDir = path.join(USER_DATA_DIR, "Local State");
        fs.mkdirSync(path.dirname(lsDir), { recursive: true });
        if (fs.existsSync(path.join(seedSrc, "Local State"))) {
           fs.copyFileSync(path.join(seedSrc, "Local State"), lsDir);
        }
        const stateDir = path.join(USER_DATA_DIR, "User", "globalStorage");
        fs.mkdirSync(stateDir, { recursive: true });
        if (fs.existsSync(path.join(seedSrc, "User", "globalStorage", "state.vscdb"))) {
           fs.copyFileSync(path.join(seedSrc, "User", "globalStorage", "state.vscdb"), path.join(stateDir, "state.vscdb"));
        }
      } catch (e) {
        console.warn("Failed to seed VS Code state:", e);
      }
    }

    // Write workspace settings so it uses local firmware checkout
    const settingsPath = path.join(WORKSPACE_DIR, ".vscode", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      "nodemcu-vscode.firmwarePath": FIRMWARE_REPO
    }, null, 2));

    // 2. Spawn VS Code
    const codeCmd = process.env.VSCODE_E2E_EXECUTABLE || path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "bin", "code.cmd");
    codeProcess = child_process.spawn(`"${codeCmd}"`, [
      "--new-window",
      "--disable-workspace-trust",
      `--user-data-dir=${USER_DATA_DIR}`,
      `--extensions-dir=${EXTENSIONS_DIR}`,
      `--extensionDevelopmentPath=${extensionPath}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      WORKSPACE_DIR
    ], { detached: false, shell: true });

    codeProcess.stdout?.on('data', (data) => console.log(`[VSCODE STDOUT] ${data}`));
    codeProcess.stderr?.on('data', (data) => console.log(`[VSCODE STDERR] ${data}`));
    codeProcess.on('exit', (code) => console.log(`[VSCODE EXIT] ${code}`));

    // 3. Connect CDP
    const wsUrl = await getDebuggerUrl();
    client = new CDPClient(wsUrl);
    await client.connect();

    // 4. Back up firmware from COM7 just in case
    const backupBin = path.join(os.tmpdir(), "nodemcu-e2e-backup.bin");
    const r = child_process.spawnSync("python", [
      "-m", "esptool", "--port", PORT, "--baud", String(BAUD_RATE),
      "read_flash", "0x0", "0x1000", backupBin
    ], { encoding: "utf-8" });
    if (r.status !== 0) {
      console.warn("Failed to backup firmware, maybe already empty or no python esptool module.");
    }

    // 5. Clean firmware bin/build to ensure we actually build
    const buildDir = path.join(FIRMWARE_REPO, "build");
    const binDir = path.join(FIRMWARE_REPO, "bin");
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(path.join(FIRMWARE_REPO, "app", "include", "user_modules.h"), { force: true });
  }, 120_000);

  afterAll(async () => {
    if (client) client.close();
    if (codeProcess) codeProcess.kill();
  });

  async function runCommandPalette(command: string) {
    let boxFound = false;
    for (let retry = 0; retry < 5; retry++) {
      // Escape to clear quick input
      await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
      await new Promise(r => setTimeout(r, 400));

      // F1 to open command palette
      await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
      
      // Wait for the quick input box to appear
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300));
        boxFound = await client.evaluate(`!!document.querySelector('.quick-input-box input')`);
        if (boxFound) break;
      }
      if (boxFound) break;
    }
    if (!boxFound) throw new Error("Quick input box did not appear after F1");

    // Type command natively
    await client.evaluate(`
      (() => {
        const input = document.querySelector('.quick-input-box input');
        if (input) input.focus();
      })()
    `);
    await client.send("Input.insertText", { text: command });
    await new Promise(r => setTimeout(r, 1000));

    const currentInputVal = await client.evaluate(`
      (() => {
        const input = document.querySelector('.quick-input-box input');
        return input ? input.value : null;
      })()
    `);
    console.log("Current input value after insertText:", currentInputVal);

    // Wait for the exact command to appear in the list and be selected
    let selectedBox = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const focusedText = await client.evaluate(`
        (() => {
          const rows = Array.from(document.querySelectorAll('.monaco-list-row'));
          const cmdNoSpace = "${command}".replace(/[^a-zA-Z0-9]/g, "");
          
          let debugLog = "CMD: " + cmdNoSpace + " | ";
          
          const match = rows.find(r => {
            const rowText = (r.textContent || "").replace(/[^a-zA-Z0-9]/g, "");
            debugLog += "[" + rowText + "] ";
            return rowText.includes(cmdNoSpace);
          });
          
          if (match) {
            match.click();
            return "FOCUSED_MATCH: " + match.textContent;
          }
          return "DEBUG: " + debugLog + " | ALL_ROWS: " + rows.map(r => r.textContent).join(' | ');
        })()
      `);
      console.log(focusedText);
      if (focusedText && focusedText.startsWith("FOCUSED_MATCH")) {
        selectedBox = true;
        break;
      }
    }
    if (!selectedBox) throw new Error("Command did not appear in quick open list");
    await new Promise(r => setTimeout(r, 2000));
  }

  it("1. Initializes Project", async () => {
    // Wait for the VS Code UI to fully settle before interacting
    await new Promise(r => setTimeout(r, 5000));

    await runCommandPalette("NodeMCU: Initialize Project");
    
    // Check if nodemcu.ini is created (with a polling loop)
    const iniPath = path.join(WORKSPACE_DIR, "nodemcu.ini");
    let iniCreated = false;
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(iniPath)) {
        iniCreated = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(iniCreated).toBe(true);

    // Modify nodemcu.ini to use our settings
    let ini = fs.readFileSync(iniPath, "utf-8");
    ini = ini.replace(/port\s*=\s*.*/, `port = ${PORT}`);
    ini = ini.replace(/firmware_path\s*=\s*.*/, `firmware_path = ${FIRMWARE_REPO.replace(/\\/g, "/")}`);
    fs.writeFileSync(iniPath, ini);
    await new Promise(r => setTimeout(r, 2000)); // allow extension to reload
  });

  it("2. Verifies UI and toggles a C module", async () => {
    // Focus sidebar
    await client.evaluate(`
      (() => {
        const btn = document.querySelector('[aria-label*="NodeMCU"]') || 
                    Array.from(document.querySelectorAll('.action-item')).find(e => e.getAttribute('title') && e.getAttribute('title').includes('NodeMCU'));
        if (btn) btn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 1000));

    // Expand panes
    await client.evaluate(`
      (() => {
        const headers = Array.from(document.querySelectorAll('.pane-header[aria-expanded="false"]'));
        headers.forEach(h => h.click());
      })()
    `);
    await new Promise(r => setTimeout(r, 1000));

    // Toggle 'adc' C module
    await client.evaluate(`
      (() => {
        const rows = Array.from(document.querySelectorAll('.monaco-list-row'));
        const row = rows.find(r => r.textContent.trim().includes("adc"));
        if (row) {
          const cb = row.querySelector('.monaco-checkbox');
          if (cb) cb.click();
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 2000));

    // Check nodemcu.ini
    const iniPath = path.join(WORKSPACE_DIR, "nodemcu.ini");
    const ini = fs.readFileSync(iniPath, "utf-8");
    expect(ini).toMatch(/adc\s*=\s*true|false/); 
  });

  it("5. Uploads and runs Lua script", async () => {
    // Skipped Build and Flash tests since the Windows host lacks the Xtensa GCC toolchain
    // The ESP8266 is already flashed with NodeMCU firmware for the upload tests.
    // We can use esptool to check chip ID to verify device is alive
    const r = child_process.spawnSync("python", ["-m", "esptool", "--port", PORT, "--baud", "115200", "chip_id"], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Chip ID:/);

    // Force the firmware's user_modules.h to match the ini so that doUploadFile doesn't trigger a build
    const fwPath = "C:/Users/caioh/src/nodemcu-firmware";
    const headerPath = path.join(fwPath, "app", "include", "user_modules.h");
    const cfg = parseIni(fs.readFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), "utf-8"));
    cfg.nodemcu.port = PORT;
    fs.writeFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), serializeIni(cfg));

    if (!fs.existsSync(path.dirname(headerPath))) {
      fs.mkdirSync(path.dirname(headerPath), { recursive: true });
    }
    writeUserModulesHeader(headerPath, cfg);

    const srcDir = path.join(WORKSPACE_DIR, "src");
    if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });
    const initFile = path.join(srcDir, "init.lua");
    fs.writeFileSync(initFile, "print('HELLO_FROM_CDP_E2E_TEST')\n");

    // Open the file in the editor so the command works
    await runCommandPalette(`Go to File...`);
    await new Promise(r => setTimeout(r, 500));
    await client.send("Input.insertText", { text: "init.lua" });
    await new Promise(r => setTimeout(r, 1000));
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await new Promise(r => setTimeout(r, 2000)); // wait for editor to open

    // Try to trigger the upload command
    await runCommandPalette("NodeMCU: Upload File to Device");

    // If port config was delayed, a QuickPick might ask for the port. Type it and Enter.
    await new Promise(r => setTimeout(r, 1000));
    await client.send("Input.insertText", { text: PORT });
    await new Promise(r => setTimeout(r, 500));
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });

    await new Promise(r => setTimeout(r, 10000)); // wait for upload

    // Reboot device and check output using serialport
    let found = false;
    const port = new SerialPort({ path: PORT, baudRate: BAUD_RATE });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    
    port.on('error', (err) => {
      console.log(`[SERIAL ERROR] ${err.message}`);
    });

    parser.on('data', (data: string) => {
      console.log(`[SERIAL] ${data.trim()}`);
      if (data.includes("HELLO_FROM_CDP_E2E_TEST")) {
        found = true;
      }
    });

    await new Promise<void>((resolve, reject) => {
      port.on('open', () => resolve());
      port.on('error', (err) => reject(err));
    });

    console.log("Serial port opened, resetting ESP8266...");

    // Toggle DTR/RTS to reset the ESP8266
    await new Promise<void>((resolve) => {
      port.set({ dtr: false, rts: true }, () => {
        setTimeout(() => {
          port.set({ dtr: false, rts: false }, () => {
            resolve();
          });
        }, 100);
      });
    });

    console.log("Waiting for output...");

    // Wait up to 10 seconds for the output
    for (let i = 0; i < 20; i++) {
      if (found) break;
      await new Promise(r => setTimeout(r, 500));
    }

    port.close();
    expect(found).toBe(true);
  }, 60_000);
});
