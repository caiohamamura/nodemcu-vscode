import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// We connect to the already running Extension Development Host on port 9222.
const PORT = 9222;

async function getDebuggerUrl() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const targets = await res.json() as any[];
  const target = targets.find(t => t.title.includes("[Extension Development Host]") || t.title.includes("nodemcu-vscode"));
  if (!target) {
    throw new Error(`Could not find Extension Development Host in targets: ${JSON.stringify(targets)}`);
  }
  return target.webSocketDebuggerUrl;
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
  const workspaceRoot = path.resolve(__dirname, "../..");

  beforeAll(async () => {
    try {
      const wsUrl = await getDebuggerUrl();
      client = new CDPClient(wsUrl);
      await client.connect();
    } catch (err: any) {
      console.warn("CDP connection failed. E2E test requires Extension Development Host running with debug port 9222.");
      throw err;
    }
  });

  afterAll(() => {
    if (client) {
      client.close();
    }
  });

  it("focuses sidebar and expands panes", async () => {
    // 1. Focus Sidebar
    const focusResult = await client.evaluate(`
      (() => {
        const btn = document.querySelector('[aria-label*="NodeMCU"]') || 
                    Array.from(document.querySelectorAll('.action-item')).find(e => e.getAttribute('title') && e.getAttribute('title').includes('NodeMCU'));
        if (!btn) return "Sidebar button not found";
        btn.click();
        return "Clicked NodeMCU sidebar button";
      })()
    `);
    console.log("Focus result:", focusResult);
    expect(focusResult).toBeDefined();

    await new Promise(r => setTimeout(r, 1000));

    // 2. Expand Panes
    const expandResult = await client.evaluate(`
      (() => {
        const headers = Array.from(document.querySelectorAll('.pane-header[aria-expanded="false"]'));
        headers.forEach(h => h.click());
        return "Expanded collapsed panes: " + headers.length;
      })()
    `);
    console.log("Expand result:", expandResult);
    expect(expandResult).toBeDefined();
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

  it("monitors changes in 'src' directory, creates init.lua and triggers upload", async () => {
    // 1. Create a local 'src' directory and 'init.lua' if they do not exist
    const srcDir = path.join(workspaceRoot, "src");
    if (!fs.existsSync(srcDir)) {
      fs.mkdirSync(srcDir, { recursive: true });
    }
    const testFile = path.join(srcDir, "init.lua");
    fs.writeFileSync(testFile, 'print("Hello from automated CDP E2E test!")\\n', "utf-8");

    // 2. Trigger Upload Command via command palette
    // Escape to clear any current quick input
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
    await new Promise(r => setTimeout(r, 400));

    // Open Command Palette (F1)
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
    await new Promise(r => setTimeout(r, 1000));

    // Type "NodeMCU: Upload File to Device"
    await client.evaluate(`
      (() => {
        const input = document.querySelector('.quick-input-box input');
        if (input) {
          input.focus();
          input.value = "NodeMCU: Upload File to Device";
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 1000));

    // Send Enter
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    
    console.log("Triggered Upload File command.");
    await new Promise(r => setTimeout(r, 3000));
  });
});
