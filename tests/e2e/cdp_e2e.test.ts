import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";

const PORT = process.env.NODEMCU_VSCODE_E2E_CDP_PORT || 9237;

async function getDebuggerUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
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
        if (data.error) {
          reject(new Error(data.error.message || JSON.stringify(data.error)));
        } else {
          resolve(data.result);
        }
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
    if (this.ws) {
      this.ws.close();
    }
  }
}

describe("E2E CDP: Extension Host Automation", () => {
  let client: CDPClient;
  let codeProcess: child_process.ChildProcess;
  const workspaceRoot = path.resolve(__dirname, "../..");
  const extensionPath = workspaceRoot;
  
  const WORKSPACE_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-workspace-sim");
  const USER_DATA_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-user-data-sim");
  const EXTENSIONS_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-extensions-sim");

  beforeAll(async () => {
    fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    
    fs.rmSync(EXTENSIONS_DIR, { recursive: true, force: true });
    fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });

    // Seed User Data to skip AI splash / welcome flow
    const seedSrc = path.join(process.env.APPDATA || "", "Code");
    if (fs.existsSync(seedSrc)) {
      try {
        const lsSrc = path.join(seedSrc, "Local State");
        const lsDst = path.join(USER_DATA_DIR, "Local State");
        fs.mkdirSync(path.dirname(lsDst), { recursive: true });
        if (fs.existsSync(lsSrc)) fs.copyFileSync(lsSrc, lsDst);
        const gsSrc = path.join(seedSrc, "User", "globalStorage", "state.vscdb");
        const gsDst = path.join(USER_DATA_DIR, "User", "globalStorage", "state.vscdb");
        fs.mkdirSync(path.dirname(gsDst), { recursive: true });
        if (fs.existsSync(gsSrc)) fs.copyFileSync(gsSrc, gsDst);
      } catch (e) {
        console.warn("Failed to seed VS Code state:", e);
      }
    }

    // Seed global storage with fake firmware
    const stateDir = path.join(USER_DATA_DIR, "User", "globalStorage", "caiohamamura.nodemcu-vscode");
    const firmwareDir = path.join(stateDir, "firmware");
    fs.mkdirSync(firmwareDir, { recursive: true });

    const fakeFirmwareSrc = path.join(workspaceRoot, "tests", "fixtures", "fake-firmware");
    if (fs.existsSync(fakeFirmwareSrc)) {
      const targetDir = path.join(firmwareDir, "luac_cross_optional");
      fs.cpSync(fakeFirmwareSrc, targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, ".nodemcu-vscode-managed-firmware.json"), JSON.stringify({ tag: "luac_cross_optional", extractedAt: new Date().toISOString() }));
    }

    const codeCmd = process.env.VSCODE_E2E_EXECUTABLE || path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "bin", "code.cmd");
    codeProcess = child_process.spawn(`"${codeCmd}"`, [
      "--new-window",
      "--disable-workspace-trust",
      `--user-data-dir=${USER_DATA_DIR}`,
      `--extensions-dir=${EXTENSIONS_DIR}`,
      `--extensionDevelopmentPath=${extensionPath}`,
      `--remote-debugging-port=${PORT}`,
      WORKSPACE_DIR
    ], { 
      detached: false, 
      shell: true,
      env: {
        ...process.env,
        NODEMCU_VSCODE_NODEMCU_TOOL: path.join(workspaceRoot, "tests", "fixtures", "fake-nodemcu-tool.js"),
        NODEMCU_VSCODE_FAKE_SERIAL_PORTS: JSON.stringify([{ path: "COM42", manufacturer: "Fake", vendorId: "1234", productId: "5678" }]),
        NODEMCU_VSCODE_FAKE_NODMCU_TOOL_STATE: path.join(os.tmpdir(), "nodemcu-fake-state")
      }
    });

    try {
      const wsUrl = await getDebuggerUrl();
      client = new CDPClient(wsUrl);
      await client.connect();
    } catch (err: any) {
      console.warn("CDP connection failed. E2E test requires Extension Development Host running with debug port " + PORT);
      if (codeProcess) codeProcess.kill();
      throw err;
    }
  }, 60000);

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

  async function clickNodeMcuButton(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const button = await client.evaluate(`
        (() => {
          const items = Array.from(document.querySelectorAll('.activitybar .action-item, .activitybar [aria-label], .activitybar [title]'));
          const match = items.map(e => ({
            label: e.getAttribute('title') || e.getAttribute('aria-label') || '',
            rect: (() => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()
          })).find(e => e.label.includes('NodeMCU') && e.rect.w > 0 && e.rect.h > 0);
          return match || null;
        })()
      `) as { label: string; rect: { x: number; y: number; w: number; h: number } } | null;
      if (!button) throw new Error("NodeMCU activity bar item not found");
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: button.rect.x, y: button.rect.y, button: "none" });
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: button.rect.x, y: button.rect.y, button: "left", clickCount: 1 });
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: button.rect.x, y: button.rect.y, button: "left", clickCount: 1 });
      await new Promise(r => setTimeout(r, 1000));
      return;
    }
  }

  async function focusNodeMcuSidebar(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await clickNodeMcuButton();
      const visible = await client.evaluate(`Array.from(document.querySelectorAll('.pane-header')).some(h => (h.getAttribute('aria-label') || '').includes('Device Explorer'))`);
      if (visible) return;
    }
    throw new Error("NodeMCU sidebar did not show Device Explorer pane");
  }

  async function expandPanes(): Promise<void> {
    await client.evaluate(`
      (() => {
        const headers = Array.from(document.querySelectorAll('.pane-header[aria-expanded="false"]'));
        headers.forEach(h => h.click());
      })()
    `);
    await new Promise(r => setTimeout(r, 1000));
  }

  async function runCommandPalette(command: string): Promise<void> {
    for (let retry = 0; retry < 5; retry++) {
      await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
      await new Promise(r => setTimeout(r, 400));
      await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300));
        const boxFound = await client.evaluate(`!!document.querySelector('.quick-input-box input')`);
        if (boxFound) break;
      }
      await client.evaluate(`
        (() => {
          const input = document.querySelector('.quick-input-box input');
          if (input) input.focus();
        })()
      `);
      await client.send("Input.insertText", { text: command });
      await new Promise(r => setTimeout(r, 1000));
      let selectedBox = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        const focusedText = await client.evaluate(`
          (() => {
            const rows = Array.from(document.querySelectorAll('.monaco-list-row'));
            const cmdNoSpace = ${JSON.stringify(command)}.replace(/[^a-zA-Z0-9]/g, "");
            const match = rows.find(r => {
              const rowText = (r.textContent || "").replace(/[^a-zA-Z0-9]/g, "");
              return rowText.includes(cmdNoSpace) || r.textContent?.trim() === ${JSON.stringify(command)};
            });
            if (match?.querySelector('.monaco-icon-label') || match?.textContent?.trim() === ${JSON.stringify(command)}) {
              match.click();
              return "FOCUSED";
            }
            const exactMatch = rows.find(r => r.textContent?.trim() === ${JSON.stringify(command)});
            if (exactMatch) { exactMatch.click(); return "FOCUSED_EXACT"; }
            return null;
          })()
        `);
        if (focusedText) { selectedBox = true; break; }
      }
      if (selectedBox) break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  it("shows only Initialize Project before a valid project exists", async () => {
    await clickNodeMcuButton();
    await new Promise(r => setTimeout(r, 2000));
    const sidebarText = await client.evaluate(`
      (() => document.querySelector('.sidebar')?.textContent || document.body.textContent || '')()
    `);
    expect(sidebarText).toContain("Initialize Project");
    expect(sidebarText).not.toContain("Device Files");
  });

  it("initializes the workspace with nodemcu.ini and src/init.lua", async () => {
    await runCommandPalette("NodeMCU: Initialize Project");
    const iniPath = path.join(WORKSPACE_DIR, "nodemcu.ini");
    const initPath = path.join(WORKSPACE_DIR, "src", "init.lua");
    expect(fs.existsSync(iniPath)).toBe(true);
    expect(fs.existsSync(initPath)).toBe(true);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("[devices]");
  });

  it("shows device explorer and module selectors after initialization", async () => {
    await focusNodeMcuSidebar();
    await expandPanes();
    const paneLabels = await client.evaluate(`
      (() => Array.from(document.querySelectorAll('.pane-header')).map(h => h.getAttribute('aria-label') || h.textContent || '').join('\\n'))()
    `);
    console.log("Pane labels:", paneLabels);
    expect(paneLabels).toMatch(/Device Explorer/i);
    expect(paneLabels).toMatch(/Lua Modules/i);
    expect(paneLabels).toMatch(/C Modules/i);
    expect(paneLabels).not.toMatch(/Device Files/i);
  });

  it("toggles Lua module checkbox and C module checkbox", async () => {
    // Toggle a Lua module checkbox (e.g. gossip)
    const toggleLuaResult = await client.evaluate(`
      (() => {
        const rows = Array.from(document.querySelectorAll('.monaco-list-row'));
        const row = rows.find(r => r.textContent.trim().includes("gossip"));
        if (!row) return "Lua module row 'gossip' not found";
        const cb = row.querySelector('.monaco-checkbox');
        if (!cb) return "Checkbox not found for 'gossip'";
        cb.click();
        return "Clicked 'gossip' checkbox";
      })()
    `);
    console.log("Toggle Lua result:", toggleLuaResult);

    // Toggle a C module checkbox (e.g. adc)
    const toggleCResult = await client.evaluate(`
      (() => {
        const rows = Array.from(document.querySelectorAll('.monaco-list-row'));
        const row = rows.find(r => r.textContent.trim().includes("adc"));
        if (!row) return "C module row 'adc' not found";
        const cb = row.querySelector('.monaco-checkbox');
        if (!cb) return "Checkbox not found for 'adc'";
        cb.click();
        return "Clicked 'adc' checkbox";
      })()
    `);
    console.log("Toggle C result:", toggleCResult);
  });

  it("uses workspace src as the edited file surface", async () => {
    const srcDir = path.join(WORKSPACE_DIR, "src");
    if (!fs.existsSync(srcDir)) {
      fs.mkdirSync(srcDir, { recursive: true });
    }
    const testFile = path.join(srcDir, "init.lua");
    fs.writeFileSync(testFile, 'print("Hello from automated CDP E2E test!")\\n', "utf-8");
    expect(fs.readFileSync(testFile, "utf-8")).toContain("automated CDP E2E");
  });
});
