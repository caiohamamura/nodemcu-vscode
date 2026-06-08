import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { writeUserModulesHeader } from "../../src/build/userModulesWriter";
import { parseIni, serializeIni } from "../../src/config/nodemcuIni";

const PORT = process.env.NODEMCU_VSCODE_E2E_SERIAL_PORT || "COM7";
const BAUD_RATE = Number(process.env.NODEMCU_VSCODE_E2E_SERIAL_BAUD || "460800");
const DEBUG_PORT = Number(process.env.NODEMCU_VSCODE_E2E_CDP_PORT || "9238");
const FIRMWARE_REPO = process.env.NODEMCU_VSCODE_E2E_FIRMWARE_REPO || "C:/Users/caioh/src/nodemcu-firmware";
const PYTHON = process.env.NODEMCU_VSCODE_E2E_PYTHON || process.env.NODEMCU_VSCODE_PYTHON || "C:/Users/caioh/micromamba/envs/esp/python.exe";
const RUN_ID = `${process.pid}-${Date.now()}`;
const WORKSPACE_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-workspace");
const USER_DATA_DIR = path.join(os.tmpdir(), `nodemcu-vscode-e2e-user-data-${RUN_ID}`);
const EXTENSIONS_DIR = path.join(os.tmpdir(), `nodemcu-vscode-e2e-extensions-${RUN_ID}`);
const REQUIRED_UPLOAD_MODULES = ["file", "node", "uart", "tmr", "gpio", "wifi"];

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
    const r = child_process.spawnSync(PYTHON, ["-c", "import esptool; print(esptool.__version__)"], { encoding: "utf-8" });
    return r.status === 0 && /^\d+\.\d+/.test(r.stdout.trim());
  } catch {
    return false;
  }
})();

const describe_ = hasFirmwareRepo && hasCMake && hasEsptool ? describe : describe.skip;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

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
      "nodemcu-vscode.firmwarePath": FIRMWARE_REPO,
      "nodemcu-vscode.pythonPath": PYTHON
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
    const r = child_process.spawnSync(PYTHON, [
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

  afterAll(() => {
    if (client) {
      try {
        client.send("Browser.close").catch(() => {});
      } catch { /* ignore */ }
      client.close();
    }
    if (codeProcess) {
      if (process.platform === "win32" && codeProcess.pid) {
        child_process.spawnSync("taskkill", ["/pid", codeProcess.pid.toString(), "/f", "/t"]);
      } else {
        codeProcess.kill();
      }
    }
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

  function jsString(value: string): string {
    return JSON.stringify(value);
  }

  async function pressKey(key: string, code: string, windowsVirtualKeyCode: number, modifiers = 0): Promise<void> {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode, key, code, modifiers });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode, key, code, modifiers });
  }

  async function pressModifiedKey(key: string, code: string, windowsVirtualKeyCode: number): Promise<void> {
    const modifier = process.platform === "darwin" ? 4 : 2;
    await pressKey(key, code, windowsVirtualKeyCode, modifier);
  }

  async function clickAt(x: number, y: number): Promise<void> {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async function focusNodeMcuSidebar(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const button = await client.evaluate(`
        (() => {
          const items = Array.from(document.querySelectorAll('.activitybar .action-item, .activitybar [aria-label], .activitybar [title]'));
          const match = items
            .map(e => ({
              label: e.getAttribute('title') || e.getAttribute('aria-label') || '',
              rect: (() => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()
            }))
            .find(e => e.label.includes('NodeMCU') && e.rect.w > 0 && e.rect.h > 0);
          return match || null;
        })()
      `) as { label: string; rect: { x: number; y: number; w: number; h: number } } | null;
      if (!button) throw new Error("NodeMCU activity bar item was not found");
      await clickAt(button.rect.x, button.rect.y);
      await sleep(1000);
      const visible = await client.evaluate(`
        (() => Array.from(document.querySelectorAll('.pane-header'))
          .some(h => (h.getAttribute('aria-label') || '').includes('Device Explorer')))()
      `);
      if (visible) return;
    }
    throw new Error("NodeMCU sidebar did not show the Device Explorer pane");
  }

  async function expandSidebarPanes(): Promise<void> {
    await client.evaluate(`
      (() => {
        const headers = Array.from(document.querySelectorAll('.pane-header[aria-expanded="false"]'));
        headers.forEach(h => h.click());
      })()
    `);
    await sleep(1000);
  }

  async function getActiveEditorSummary(): Promise<{ tab: string; aria: string; text: string }> {
    return await client.evaluate(`
      (() => {
        const activeTab = document.querySelector('.tab.active') || document.querySelector('.tab[aria-selected="true"]');
        const activeGroup = Array.from(document.querySelectorAll('.editor-group-container')).find(g => g.classList.contains('active')) ||
          document.querySelector('.editor-group-container');
        const root = activeGroup || document;
        const editor = root.querySelector('.monaco-editor') || document.querySelector('.monaco-editor');
        const lines = editor ? Array.from(editor.querySelectorAll('.view-lines .view-line')) : [];
        return {
          tab: activeTab ? (activeTab.textContent || '').trim().replace(/\\s+/g, ' ') : '',
          aria: activeTab ? (activeTab.getAttribute('aria-label') || activeTab.getAttribute('title') || '') : '',
          text: lines.map(l => (l.textContent || '').replace(/\u00a0/g, ' ')).join('\\n')
        };
      })()
    `);
  }

  async function waitForActiveEditor(remoteName: string, expectedText: string, timeoutMs = 45_000): Promise<{ tab: string; aria: string; text: string }> {
    const started = Date.now();
    let last = { tab: "", aria: "", text: "" };
    while (Date.now() - started < timeoutMs) {
      last = await getActiveEditorSummary();
      if ((last.tab.includes(remoteName) || last.aria.includes(remoteName)) && last.text.includes(expectedText)) {
        return last;
      }
      await sleep(500);
    }
    throw new Error(`Timed out waiting for live editor ${remoteName}. Last editor: ${JSON.stringify(last)}`);
  }

  async function focusActiveEditor(): Promise<void> {
    const target = await client.evaluate(`
      (() => {
        const activeGroup = Array.from(document.querySelectorAll('.editor-group-container')).find(g => g.classList.contains('active')) ||
          document.querySelector('.editor-group-container');
        const root = activeGroup || document;
        const editor = root.querySelector('.monaco-editor') || document.querySelector('.monaco-editor');
        const input = root.querySelector('.monaco-editor textarea.inputarea') ||
          root.querySelector('.monaco-editor textarea') ||
          document.querySelector('.monaco-editor textarea.inputarea') ||
          document.querySelector('.monaco-editor textarea');
        const editorSurface = editor?.querySelector('.view-lines') || editor;
        if (!editorSurface) {
          if (input) {
            input.focus();
            return { focused: true };
          }
          return { focused: false };
        }
        const rect = editorSurface.getBoundingClientRect();
        return {
          focused: false,
          x: rect.left + Math.min(80, Math.max(20, rect.width / 4)),
          y: rect.top + Math.min(24, Math.max(12, rect.height / 3))
        };
      })()
    `) as { focused: boolean; x?: number; y?: number };
    if (target.x !== undefined && target.y !== undefined) {
      await clickAt(target.x, target.y);
      await sleep(250);
      return;
    }
    if (target.focused) {
      await sleep(250);
      return;
    }
    throw new Error("Unable to focus the active editor input");
  }

  async function replaceActiveEditorText(text: string): Promise<void> {
    await focusActiveEditor();
    await pressModifiedKey("a", "KeyA", 65);
    await sleep(150);
    await client.send("Input.insertText", { text });
    await sleep(250);
  }

  async function saveActiveEditor(): Promise<void> {
    await focusActiveEditor();
    await pressModifiedKey("s", "KeyS", 83);
    await sleep(150);
  }

  async function waitForLiveSaveResult(remoteName: string, timeoutMs = 70_000): Promise<"success" | "error" | "timeout"> {
    const started = Date.now();
    let lastErrorStatus = "";
    while (Date.now() - started < timeoutMs) {
      const joined = (await getStatusItems()).join(" | ");
      if (/synced\s+\d+\s+operation/i.test(joined)) return "success";
      if (/sync FAILED|upload FAILED|save FAILED|error/i.test(joined)) lastErrorStatus = joined;
      await sleep(500);
    }
    console.log(`Timed out waiting for save-sync result for ${remoteName}. Last error status: ${lastErrorStatus}`);
    await dumpNodeMcuOutput();
    return lastErrorStatus ? "error" : "timeout";
  }

  async function closeSerialPort(port: SerialPort): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!port.isOpen) {
        resolve();
        return;
      }
      port.close((error) => error ? reject(error) : resolve());
    });
    await new Promise(r => setTimeout(r, process.platform === "win32" ? 1500 : 250));
  }

  async function dumpNodeMcuOutput(): Promise<string> {
    try {
      await runCommandPalette("Output: Focus on Output View");
      await new Promise(r => setTimeout(r, 1000));
      await runCommandPalette("Output: Show Output Channels...");
      await client.send("Input.insertText", { text: "NodeMCU" });
      await new Promise(r => setTimeout(r, 500));
      await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
      await new Promise(r => setTimeout(r, 1000));
      const text = await client.evaluate(`
        (() => {
          const panel = document.querySelector('.panel') || document.body;
          return panel ? (panel.textContent || '').slice(-8000) : '';
        })()
      `);
      console.log("=== NodeMCU Output Panel Tail ===\n" + text);
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log("Failed to dump NodeMCU output panel:", message);
      return "";
    }
  }

  async function getStatusItems(): Promise<string[]> {
    return await client.evaluate(`
      (() => Array.from(document.querySelectorAll('.statusbar-item'))
        .map(el => (el.textContent || '').trim().replace(/\\s+/g, ' '))
        .filter(Boolean))()
    `);
  }

  async function waitForUploadResult(timeoutMs = 45_000): Promise<"success" | "error" | "timeout"> {
    const started = Date.now();
    let sawActiveState = false;
    while (Date.now() - started < timeoutMs) {
      const status = await getStatusItems();
      const joined = status.join(" | ");
      if (/uploading|building|flashing|formatting|syncing/i.test(joined)) {
        sawActiveState = true;
      }
      if (/sync FAILED|upload FAILED|error/i.test(joined)) {
        console.log("Upload status indicates failure:", joined);
        await dumpNodeMcuOutput();
        return "error";
      }
      if (sawActiveState && /synced \d+ operation/i.test(joined)) {
        console.log("Upload status indicates success:", joined);
        return "success";
      }
      await new Promise(r => setTimeout(r, 500));
    }
    console.log("Timed out waiting for upload result. Status:", (await getStatusItems()).join(" | "));
    await dumpNodeMcuOutput();
    return "timeout";
  }

  async function verifyInitLuaPrints(marker: string): Promise<boolean> {
    let found = false;
    const lines: string[] = [];
    const port = new SerialPort({ path: PORT, baudRate: BAUD_RATE });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

    port.on('error', (err) => {
      console.log(`[SERIAL ERROR] ${err.message}`);
    });

    parser.on('data', (data: string) => {
      const line = data.trim();
      lines.push(line);
      console.log(`[SERIAL] ${line}`);
      if (data.includes(marker)) {
        found = true;
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        port.on('open', () => resolve());
        port.on('error', (err) => reject(err));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Unable to open serial port for verification: ${message}`);
      await closeSerialPort(port);
      return false;
    }

    console.log("Serial port opened, issuing node.restart()...");
    await new Promise<void>((resolve, reject) => {
      port.write("\r\nnode.restart()\r\n", (writeError) => {
        if (writeError) {
          reject(writeError);
          return;
        }
        port.drain((drainError) => drainError ? reject(drainError) : resolve());
      });
    });

    for (let i = 0; i < 24; i++) {
      if (found) break;
      await new Promise(r => setTimeout(r, 500));
    }

    await closeSerialPort(port);
    if (!found) {
      console.log(`Did not observe ${marker}. Serial tail:\n${lines.slice(-40).join("\n")}`);
    }
    return found;
  }

  async function clickNotificationAction(label: string, timeoutMs = 30_000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const clicked = await client.evaluate(`
        (() => {
          const label = ${jsString(label)};
          const buttons = Array.from(document.querySelectorAll('a.monaco-button,.monaco-button,button,.action-label'));
          const button = buttons.find((e) => ((e.textContent || e.getAttribute('aria-label') || '').trim() === label));
          if (!button) return false;
          button.click();
          return true;
        })()
      `);
      if (clicked) return true;
      await sleep(500);
    }
    return false;
  }

  async function captureRestartOutputLines(timeoutMs = 14_000): Promise<string[]> {
    const chunks: string[] = [];
    let port: SerialPort | undefined;

    const openPort = async (): Promise<SerialPort> => {
      const started = Date.now();
      let lastError = "";
      while (Date.now() - started < 20_000) {
        const candidate = new SerialPort({ path: PORT, baudRate: BAUD_RATE, autoOpen: false });
        candidate.on('error', (err) => {
          console.log(`[SERIAL ERROR] ${err.message}`);
        });
        candidate.on('data', (data: Buffer) => {
          const text = data.toString("utf-8");
          chunks.push(text);
          for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
            console.log(`[SERIAL] ${line}`);
          }
        });
        try {
          await new Promise<void>((resolve, reject) => {
            candidate.open((error) => error ? reject(error) : resolve());
          });
          return candidate;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          await closeSerialPort(candidate).catch(() => undefined);
          await sleep(1000);
        }
      }
      throw new Error(lastError || `Unable to open ${PORT}`);
    };

    port = await openPort();

    try {
      await new Promise<void>((resolve, reject) => port.set({ dtr: false, rts: true }, (error) => error ? reject(error) : resolve()));
      await sleep(100);
      await new Promise<void>((resolve, reject) => port.set({ dtr: false, rts: false }, (error) => error ? reject(error) : resolve()));
      await sleep(timeoutMs);
      return chunks.join("").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } finally {
      if (port) await closeSerialPort(port);
    }
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
    const portMatch = ini.match(/port\s*=\s*([^\r\n]*)/);
    if (portMatch) {
      ini = ini.replace(portMatch[0], `port = ${PORT}`);
    } else {
      ini = ini.replace(/\[nodemcu\]/, `[nodemcu]\nport = ${PORT}`);
    }
    const fwMatch = ini.match(/firmware_path\s*=\s*([^\r\n]*)/);
    if (fwMatch) {
      ini = ini.replace(fwMatch[0], `firmware_path = ${FIRMWARE_REPO.replace(/\\/g, "/")}`);
    } else {
      ini = ini.replace("[nodemcu]", `[nodemcu]\nfirmware_path = ${FIRMWARE_REPO.replace(/\\/g, "/")}`);
    }
    fs.writeFileSync(iniPath, ini);
    await new Promise(r => setTimeout(r, 2000)); // allow extension to reload
  });

  it("2. Verifies UI and toggles a C module", async () => {
    await focusNodeMcuSidebar();
    await expandSidebarPanes();

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
    // Force the firmware's user_modules.h to match the ini so that doUploadFile doesn't trigger a build
    const fwPath = "C:/Users/caioh/src/nodemcu-firmware";
    const headerPath = path.join(fwPath, "app", "include", "user_modules.h");
    const cfg = parseIni(fs.readFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), "utf-8"));
    cfg.nodemcu.port = PORT;
    cfg.nodemcu.baud = BAUD_RATE;
    cfg.nodemcu.upload_baud = BAUD_RATE;
    cfg.devices.uuids = [];
    for (const moduleName of REQUIRED_UPLOAD_MODULES) {
      cfg.c_modules[moduleName] = true;
    }
    fs.writeFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), serializeIni(cfg));

    if (!fs.existsSync(path.dirname(headerPath))) {
      fs.mkdirSync(path.dirname(headerPath), { recursive: true });
    }
    writeUserModulesHeader(headerPath, cfg);

    const srcDir = path.join(WORKSPACE_DIR, "src");
    if (!fs.existsSync(srcDir)) {
      fs.mkdirSync(srcDir, { recursive: true });
    }
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
    expect(await clickNotificationAction("Proceed", 45_000)).toBe(true);

    expect(await waitForUploadResult()).toBe("success");
    const afterSync = parseIni(fs.readFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), "utf-8"));
    expect(afterSync.devices.uuids.length).toBeGreaterThan(0);

    const found = await verifyInitLuaPrints("HELLO_FROM_CDP_E2E_TEST");
    if (!found) await dumpNodeMcuOutput();
    expect(found).toBe(true);
  }, 100_000);

  it("6. Uploads changes and stops open serial monitors", async () => {
    // Close the active text editor to ensure the extension falls back to the "src" folder
    await runCommandPalette("View: Close Editor");
    await new Promise(r => setTimeout(r, 500));

    const srcDir = path.join(WORKSPACE_DIR, "src");
    
    // Modify the file on disk
    fs.writeFileSync(path.join(srcDir, "init.lua"), "print('HELLO_FROM_UPLOAD_CHANGES')\n");

    // Open Serial Monitor using command palette
    await runCommandPalette("NodeMCU: Open Serial Monitor");
    await new Promise(r => setTimeout(r, 3000)); // wait for terminal to open and lock COM port

    // Trigger Upload Changes (this should close the terminal automatically)
    await runCommandPalette("NodeMCU: Upload Changes to Device");
    expect(await waitForUploadResult()).toBe("success");

    const found = await verifyInitLuaPrints("HELLO_FROM_UPLOAD_CHANGES");
    if (!found) await dumpNodeMcuOutput();
    expect(found).toBe(true);
  }, 100_000);

  it("7. Saves workspace src/init.lua edits to the device", async () => {
    await runCommandPalette("Go to File...");
    await sleep(500);
    await client.send("Input.insertText", { text: "init.lua" });
    await sleep(1000);
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await sleep(2000);

    const opened = await waitForActiveEditor("init.lua", "HELLO_FROM_UPLOAD_CHANGES");
    expect(opened.tab.includes("init.lua") || opened.aria.includes("init.lua")).toBe(true);
    expect(opened.text).toContain("HELLO_FROM_UPLOAD_CHANGES");

    await replaceActiveEditorText('print("HELLO_FROM_SRC_SAVE_SYNC")\n');
    let editor = await getActiveEditorSummary();
    expect(editor.text).toContain("HELLO_FROM_SRC_SAVE_SYNC");

    await saveActiveEditor();
    expect(await waitForLiveSaveResult("init.lua")).toBe("success");

    await replaceActiveEditorText('print("HELLO_FROM_SRC_SAVE_SYNC_2")\n');
    editor = await getActiveEditorSummary();
    expect(editor.text).toContain("HELLO_FROM_SRC_SAVE_SYNC_2");

    await saveActiveEditor();
    expect(await waitForLiveSaveResult("init.lua")).toBe("success");

    await sleep(process.platform === "win32" ? 3500 : 1000);
    const lines = await captureRestartOutputLines();
    const normalizedLines = lines.map((line) => line.replace(/^>\s*/, "").trim());
    if (!normalizedLines.includes("HELLO_FROM_SRC_SAVE_SYNC_2")) {
      await dumpNodeMcuOutput();
      console.log(`Serial restart output:\n${normalizedLines.join("\n")}`);
    }
    expect(normalizedLines).toContain("HELLO_FROM_SRC_SAVE_SYNC_2");
    expect(normalizedLines).not.toContain("HELLO_FROM_SRC_SAVE_SYNC");
  }, 120_000);
});
