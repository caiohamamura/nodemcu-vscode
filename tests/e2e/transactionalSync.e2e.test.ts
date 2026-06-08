import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";

const PORT = parseInt(process.env.NODEMCU_VSCODE_E2E_CDP_PORT || "9237", 10);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

  evaluate(expression: string): Promise<any> {
    return this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    }).then((r: any) => r.result?.value);
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

async function getDebuggerUrl(): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      if (res.ok) {
        const targets = await res.json() as any[];
        const target = targets.find((t: any) => t.title.includes("[Extension Development Host]"));
        if (target) return target.webSocketDebuggerUrl;
      }
    } catch { /* ignore and retry */ }
    await sleep(1000);
  }
  throw new Error("Could not connect to EDH debugger port");
}

async function runCommandPalette(client: CDPClient, command: string): Promise<void> {
  for (let retry = 0; retry < 5; retry++) {
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
    await sleep(400);
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
    for (let i = 0; i < 10; i++) {
      await sleep(300);
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
    await sleep(1000);
    let selectedBox = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
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
  await sleep(2000);
}

async function focusNodeMcuSidebar(client: CDPClient): Promise<void> {
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
    await sleep(1000);
    const visible = await client.evaluate(`Array.from(document.querySelectorAll('.pane-header')).some(h => (h.getAttribute('aria-label') || '').includes('Device Explorer'))`);
    if (visible) return;
  }
  throw new Error("NodeMCU sidebar did not show Device Explorer pane");
}

async function pressModifiedKey(client: CDPClient, key: string, code: string, windowsVirtualKeyCode: number): Promise<void> {
  const modifier = 2; // Ctrl on Windows
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode, key, code, modifiers: modifier });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode, key, code, modifiers: modifier });
}

async function focusActiveEditor(client: CDPClient): Promise<void> {
  const target = await client.evaluate(`
    (() => {
      const activeGroup = Array.from(document.querySelectorAll('.editor-group-container')).find(g => g.classList.contains('active')) ||
        document.querySelector('.editor-group-container');
      const root = activeGroup || document;
      const editorSurface = root.querySelector('.monaco-editor .view-lines') || root.querySelector('.monaco-editor');
      const input = root.querySelector('.monaco-editor textarea.inputarea') ||
        root.querySelector('.monaco-editor textarea') ||
        document.querySelector('.monaco-editor textarea.inputarea');
      if (!editorSurface && input) { input.focus(); return { focused: true }; }
      if (!editorSurface) return { focused: false };
      const rect = editorSurface.getBoundingClientRect();
      return { focused: false, x: rect.left + Math.min(80, Math.max(20, rect.width / 4)), y: rect.top + Math.min(24, Math.max(12, rect.height / 3)) };
    })()
  `) as { focused: boolean; x?: number; y?: number };
  if (target.x !== undefined && target.y !== undefined) {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, button: "none" });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
    await sleep(250);
    return;
  }
  if (target.focused) { await sleep(250); return; }
  throw new Error("Unable to focus active editor");
}

async function getActiveEditorSummary(client: CDPClient): Promise<{ tab: string; text: string }> {
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
        text: lines.map(l => (l.textContent || '').replace(/\u00a0/g, ' ')).join('\\n')
      };
    })()
  `);
}

async function replaceActiveEditorText(client: CDPClient, text: string): Promise<void> {
  await focusActiveEditor(client);
  await pressModifiedKey(client, "a", "KeyA", 65);
  await sleep(150);
  await client.send("Input.insertText", { text });
  await sleep(250);
}

async function saveActiveEditor(client: CDPClient): Promise<void> {
  await focusActiveEditor(client);
  await pressModifiedKey(client, "s", "KeyS", 83);
  await sleep(150);
}

function parseIniTimestamp(content: string): string {
  const match = content.match(/\[sync\]\s*last_timestamp\s*=\s*([^\n\r]*)/i);
  return match ? match[1].trim() : "";
}

describe("E2E CDP: Transactional Sync", () => {
  let client: CDPClient;
  let codeProcess: child_process.ChildProcess;
  const workspaceRoot = path.resolve(__dirname, "../..");

  const WORKSPACE_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-tx-ws");
  const USER_DATA_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-tx-ud");
  const EXTENSIONS_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-tx-ext");
  const FAKE_STATE_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-tx-fake-state");
  const FAKE_ESPHOME_DIR = path.join(os.tmpdir(), "nodemcu-vscode-e2e-tx-fake-esptool");

  beforeAll(async () => {
    // Clean and create dirs
    for (const d of [WORKSPACE_DIR, USER_DATA_DIR, EXTENSIONS_DIR, FAKE_STATE_DIR, FAKE_ESPHOME_DIR]) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
    }

    // Seed managed firmware into globalStorage
    const gsDir = path.join(USER_DATA_DIR, "User", "globalStorage", "caiohamamura.nodemcu-vscode");
    const firmwareDir = path.join(gsDir, "firmware");
    fs.mkdirSync(firmwareDir, { recursive: true });
    const fakeFirmwareSrc = path.join(workspaceRoot, "tests", "fixtures", "fake-firmware");
    if (fs.existsSync(fakeFirmwareSrc)) {
      const targetDir = path.join(firmwareDir, "mbedtls-2.28.10-beta");
      fs.cpSync(fakeFirmwareSrc, targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, ".nodemcu-vscode-managed-firmware.json"),
        JSON.stringify({ tag: "mbedtls-2.28.10-beta", extractedAt: new Date().toISOString() }),
      );
    }

    // Create fake esptool Python package
    const esptoolPkg = path.join(FAKE_ESPHOME_DIR, "esptool");
    fs.mkdirSync(esptoolPkg, { recursive: true });
    fs.writeFileSync(path.join(esptoolPkg, "__init__.py"), "", "utf-8");
    fs.writeFileSync(
      path.join(esptoolPkg, "__main__.py"),
      [
        "import sys",
        "def main():",
        "    args = sys.argv[1:]",
        '    if "read-mac" in args:',
        '        print("MAC: aa:bb:cc:dd:ee:ff")',
        "        return 0",
        '    print("Unknown: " + " ".join(args), file=sys.stderr)',
        "    return 1",
        'if __name__ == "__main__":',
        "    sys.exit(main())",
      ].join("\n"),
      "utf-8",
    );

    // Write nodemcu.ini with empty sync timestamp and explicit firmware_path unset
    const iniPath = path.join(WORKSPACE_DIR, "nodemcu.ini");
    fs.writeFileSync(iniPath, [
      "[nodemcu]",
      "lua_version=53",
      "lua_number_integral=false",
      "lua_number_64bits=false",
      "port=",
      "baud=115200",
      "upload_baud=460800",
      "flash_mode=dio",
      "flash_freq=80m",
      "flash_size=4M",
      "parallel=true",
      "verbose=false",
      "src=src",
      "",
      "[devices]",
      "uuids=",
      "",
      "[sync]",
      "last_timestamp=",
      "",
      "[c_modules]",
      "file=true",
      "adc=true",
      "bit=true",
      "wifi=true",
      "",
      "[flash]",
      "extra_files=",
      "",
      "[build]",
      "parallel=true",
      "verbose=false",
    ].join("\n"), "utf-8");

    // Create src dir with init.lua
    const srcDir = path.join(WORKSPACE_DIR, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "init.lua"), 'print("hello")\n', "utf-8");
    fs.writeFileSync(path.join(srcDir, "config.lua"), '-- config\nreturn {}\n', "utf-8");

    // Launch VS Code EDH
    const codeCmd = process.env.VSCODE_E2E_EXECUTABLE ||
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "bin", "code.cmd");

    codeProcess = child_process.spawn(`"${codeCmd}"`, [
      "--new-window",
      "--disable-workspace-trust",
      `--user-data-dir=${USER_DATA_DIR}`,
      `--extensions-dir=${EXTENSIONS_DIR}`,
      `--extensionDevelopmentPath=${workspaceRoot}`,
      `--remote-debugging-port=${PORT}`,
      WORKSPACE_DIR,
    ], {
      detached: false,
      shell: true,
      env: {
        ...process.env,
        NODEMCU_VSCODE_NODEMCU_TOOL: path.join(workspaceRoot, "tests", "fixtures", "fake-nodemcu-tool.js"),
        NODEMCU_VSCODE_FAKE_SERIAL_PORTS: JSON.stringify([{ path: "COM42", manufacturer: "NodeMCU Test Board", vendorId: "1234", productId: "5678" }]),
        NODEMCU_VSCODE_FAKE_NODMCU_TOOL_STATE: FAKE_STATE_DIR,
        PYTHONPATH: FAKE_ESPHOME_DIR,
      },
    });

    try {
      const wsUrl = await getDebuggerUrl();
      client = new CDPClient(wsUrl);
      await client.connect();
    } catch (err: any) {
      console.warn("CDP connection failed. EDH must be running with debug port", PORT);
      if (codeProcess) codeProcess.kill();
      throw err;
    }
  }, 60000);

  afterAll(() => {
    if (client) {
      try { client.send("Browser.close").catch(() => {}); } catch { /* ignore */ }
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

  it("1. Initialize project and verify empty sync timestamp", async () => {
    await focusNodeMcuSidebar(client);
    await sleep(1000);

    // Initialize project command - this will create the src/init.lua and
    // register the nodemcu.ini with the config watcher
    await runCommandPalette(client, "NodeMCU: Initialize Project");
    await sleep(3000);

    // Confirm overwrite if dialog appears
    const overwriteButton = await client.evaluate(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('.monaco-button, .modals .monaco-button-text, .notification-list-item .monaco-button'));
        const match = buttons.find(b => b.textContent?.trim() === 'Overwrite');
        if (match) { match.click(); return true; }
        return false;
      })()
    `);
    if (overwriteButton) {
      await sleep(2000);
    }

    // Read the ini file directly to verify sync state
    const iniContent = fs.readFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), "utf-8");
    const timestamp = parseIniTimestamp(iniContent);
    expect(timestamp).toBe("");
  }, 60000);

  it("2. Save file triggers full sync, sets sync timestamp", async () => {
    // Open init.lua via Quick Open
    await runCommandPalette(client, "Go to File...");
    await sleep(500);
    await client.send("Input.insertText", { text: "init.lua" });
    await sleep(1000);
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await sleep(2000);

    // Verify editor has init.lua
    const editor = await getActiveEditorSummary(client);
    expect(editor.tab).toContain("init.lua");

    // Modify and save to trigger sync
    await replaceActiveEditorText(client, 'print("synced from cdp")\n');
    await saveActiveEditor(client);

    // Wait for sync to complete - check status bar for "synced"
    await sleep(1000);
    let syncCompleted = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const iniContent = fs.readFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), "utf-8");
      const timestamp = parseIniTimestamp(iniContent);
      if (timestamp) {
        syncCompleted = true;
        break;
      }
    }
    expect(syncCompleted).toBe(true);

    // Verify files ended up in the fake state dir
    const stateFiles = fs.readdirSync(FAKE_STATE_DIR);
    expect(stateFiles).toContain("init.lua");
  }, 120000);

  it("3. Re-save triggers single-file upload and updates timestamp", async () => {
    const iniBefore = fs.readFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), "utf-8");
    const timestampBefore = parseIniTimestamp(iniBefore);
    expect(timestampBefore).toBeTruthy();

    await sleep(1000);

    // Modify init.lua content and save again
    await replaceActiveEditorText(client, 'print("second save from cdp")\n');
    await sleep(500);
    await saveActiveEditor(client);

    // Wait for the sync to finish - poll nodemcu.ini for updated timestamp
    let timestampUpdated = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const iniContent = fs.readFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), "utf-8");
      const timestampAfter = parseIniTimestamp(iniContent);
      if (timestampAfter && timestampAfter !== timestampBefore) {
        timestampUpdated = true;
        break;
      }
    }
    expect(timestampUpdated).toBe(true);

    // Verify fake state still has init.lua
    const stateFiles = fs.readdirSync(FAKE_STATE_DIR);
    expect(stateFiles).toContain("init.lua");
  }, 120000);

  it("4. Save different file also updates timestamp", async () => {
    // Open config.lua
    await runCommandPalette(client, "Go to File...");
    await sleep(500);
    await client.send("Input.insertText", { text: "config.lua" });
    await sleep(1000);
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await sleep(2000);

    const iniBefore = fs.readFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), "utf-8");
    const timestampBefore = parseIniTimestamp(iniBefore);
    expect(timestampBefore).toBeTruthy();

    // Save without modifying to trigger upload
    await saveActiveEditor(client);

    let timestampUpdated = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const iniContent = fs.readFileSync(path.join(WORKSPACE_DIR, "nodemcu.ini"), "utf-8");
      const timestampAfter = parseIniTimestamp(iniContent);
      if (timestampAfter && timestampAfter !== timestampBefore) {
        timestampUpdated = true;
        break;
      }
    }
    expect(timestampUpdated).toBe(true);

    // Both files should be on the device
    const stateFiles = fs.readdirSync(FAKE_STATE_DIR);
    expect(stateFiles).toContain("init.lua");
    expect(stateFiles).toContain("config.lua");
  }, 120000);
});
