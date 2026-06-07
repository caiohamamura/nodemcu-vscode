/**
 * DevTools CDP Automation Control Script for VS Code Extension Host
 * Uses native Node.js 22 built-ins (fetch, WebSocket) to control the IDE via remote debugging.
 *
 * Usage:
 *   node cdp-control.js <action> [args...]
 *
 * Actions:
 *   focus-sidebar                 Ensure NodeMCU sidebar view is active and visible
 *   expand-panes                  Expand all collapsed panes in the current sidebar
 *   get-state                     Retrieve all rows, checkboxes, and active views in the NodeMCU sidebar
 *   toggle <module-name>          Toggle the checkbox of a module (C or Lua) in the sidebar
 *   click-row <row-text>          Perform click & double-click on a row matching the specified text
 *   run-command <command-text>    Open command palette (F1) and execute the specified command
 *   reload-window                 Reload the extension development host window
 *   capture-console               Stream console logs and IDE system logs in real-time
 */

const dns = require('node:dns');

// Force IPv4 for local lookup (prevents IPv6 connection delays on some Windows systems)
dns.setDefaultResultOrder('ipv4first');

const PORT = process.env.PORT || 9222;

async function getDebuggerUrl() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`);
    const targets = await res.json();
    const target = targets.find(t => t.title.includes("[Extension Development Host]") || t.title.includes("nodemcu-vscode"));
    if (!target) {
      throw new Error(`Could not find Extension Development Host in targets: ${JSON.stringify(targets)}`);
    }
    return target.webSocketDebuggerUrl;
  } catch (err) {
    throw new Error(`Failed to query DevTools on port ${PORT}: ${err.message}. Is the Extension Development Host running with --remote-debugging-port=${PORT}?`);
  }
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
    this.onMessageCallback = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (this.onMessageCallback) {
        this.onMessageCallback(data);
      }
      if (this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) {
          reject(data.error);
        } else {
          resolve(data.result);
        }
      }
    };

    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    await this.send("Runtime.enable");
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = this.id++;
      this.pending.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
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

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
Usage: node cdp-control.js <action> [args...]

Actions:
  focus-sidebar
  expand-panes
  get-state
  toggle <module-name>
  click-row <row-text>
  run-command <command-text>
  reload-window
  capture-console
`);
    process.exit(1);
  }

  const action = args[0];
  const url = await getDebuggerUrl();
  const client = new CDPClient(url);
  await client.connect();

  try {
    switch (action) {
      case "focus-sidebar": {
        console.log("Focusing NodeMCU sidebar...");
        const result = await client.evaluate(`
          (() => {
            const btn = document.querySelector('[aria-label*="NodeMCU"]') || 
                        Array.from(document.querySelectorAll('.action-item')).find(e => e.getAttribute('title') && e.getAttribute('title').includes('NodeMCU'));
            if (!btn) return "Sidebar button not found";
            const isSelected = btn.classList.contains('checked') || btn.classList.contains('active') || btn.getAttribute('aria-selected') === 'true' || btn.getAttribute('aria-checked') === 'true';
            if (!isSelected) {
              btn.click();
              return "Clicked NodeMCU sidebar button";
            }
            return "NodeMCU sidebar button already selected";
          })()
        `);
        console.log(result);
        break;
      }

      case "expand-panes": {
        console.log("Expanding all collapsed panes in sidebar...");
        const result = await client.evaluate(`
          (() => {
            const headers = Array.from(document.querySelectorAll('.pane-header[aria-expanded="false"]'));
            headers.forEach(h => h.click());
            return \`Expanded \${headers.length} collapsed panes\`;
          })()
        `);
        console.log(result);
        break;
      }

      case "get-state": {
        console.log("Fetching view pane state...");
        const state = await client.evaluate(`
          (() => {
            return Array.from(document.querySelectorAll('.pane')).map(pane => {
              const headerEl = pane.querySelector('.title-label');
              const header = headerEl ? headerEl.textContent.trim() : 'Unknown';
              const rows = Array.from(pane.querySelectorAll('.monaco-list-row')).map(row => {
                const cb = row.querySelector('.monaco-checkbox');
                return {
                  label: row.textContent.trim().replace(/\\s+/g, ' '),
                  checked: cb ? cb.classList.contains('checked') : null,
                  ariaLabel: row.getAttribute('aria-label') || ''
                };
              });
              return { header, rows };
            });
          })()
        `);
        console.log(JSON.stringify(state, null, 2));
        break;
      }

      case "toggle": {
        const moduleName = args[1];
        if (!moduleName) {
          throw new Error("Missing module name. Usage: toggle <module-name>");
        }
        console.log(`Toggling checkbox for module: ${moduleName}`);
        const result = await client.evaluate(`
          (() => {
            const rows = Array.from(document.querySelectorAll('.monaco-list-row'));
            const row = rows.find(r => r.textContent.trim().startsWith("${moduleName}"));
            if (!row) return { success: false, reason: "Module row not found" };
            const cb = row.querySelector('.monaco-checkbox');
            if (!cb) return { success: false, reason: "Checkbox not found inside module row" };
            cb.click();
            return { success: true };
          })()
        `);
        if (!result.success) {
          throw new Error(`Failed to toggle: ${result.reason}`);
        }
        console.log(`Successfully triggered click on module: ${moduleName}`);
        break;
      }

      case "click-row": {
        const rowText = args[1];
        if (!rowText) {
          throw new Error("Missing row text. Usage: click-row <row-text>");
        }
        console.log(`Clicking row with text: "${rowText}"`);
        const result = await client.evaluate(`
          (() => {
            const rows = Array.from(document.querySelectorAll('.monaco-list-row'));
            const row = rows.find(r => r.textContent.trim().includes("${rowText}"));
            if (!row) return { success: false, reason: "Row not found" };
            // Simulate click and double-click to cover list triggers and standard actions
            row.click();
            row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            return { success: true };
          })()
        `);
        if (!result.success) {
          throw new Error(`Failed to click row: ${result.reason}`);
        }
        console.log(`Successfully clicked row: "${rowText}"`);
        break;
      }

      case "run-command": {
        const commandText = args[1];
        if (!commandText) {
          throw new Error("Missing command name. Usage: run-command <command-text>");
        }
        console.log(`Triggering command palette and executing: "${commandText}"`);
        
        // Escape to clear any current quick input
        await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
        await new Promise(r => setTimeout(r, 400));

        // Open Command Palette (F1)
        await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
        await new Promise(r => setTimeout(r, 800));

        const isInputOpen = await client.evaluate(`!!document.querySelector('.quick-input-box input')`);
        if (!isInputOpen) {
          throw new Error("Failed to open quick input palette.");
        }

        // Set value and trigger input event
        await client.evaluate(`
          (() => {
            const input = document.querySelector('.quick-input-box input');
            input.focus();
            const val = "${commandText}";
            input.value = val.startsWith('>') ? val : '>' + val;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          })()
        `);
        await new Promise(r => setTimeout(r, 800));

        // Send Enter
        await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
        console.log("Command sent successfully.");
        break;
      }

      case "reload-window": {
        console.log("Triggering Developer: Reload Window command...");
        // Execute Developer: Reload Window command
        // Escape to clear
        await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
        await new Promise(r => setTimeout(r, 400));

        // Open F1
        await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 112, key: "F1", code: "F1" });
        await new Promise(r => setTimeout(r, 800));

        await client.evaluate(`
          (() => {
            const input = document.querySelector('.quick-input-box input');
            input.focus();
            input.value = ">Developer: Reload Window";
            input.dispatchEvent(new Event('input', { bubbles: true }));
          })()
        `);
        await new Promise(r => setTimeout(r, 800));

        // Enter
        await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
        console.log("Reload window command sent.");
        break;
      }

      case "capture-console": {
        console.log("Enabling Console log capture... Press Ctrl+C to exit.");
        await client.send("Log.enable");
        
        client.onMessageCallback = (data) => {
          if (data.method === "Runtime.consoleAPICalled") {
            const argsList = data.params.args.map(arg => {
              if (arg.value !== undefined) return String(arg.value);
              if (arg.description !== undefined) return arg.description;
              return JSON.stringify(arg);
            });
            console.log(`[Console ${data.params.type.toUpperCase()}] ${argsList.join(" ")}`);
          } else if (data.method === "Log.entryAdded") {
            const { level, text, source } = data.params.entry;
            console.log(`[IDE Log ${level.toUpperCase()} - ${source}] ${text}`);
          }
        };

        // Keep process running persistently
        await new Promise(() => {});
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } finally {
    // Only close if it's not console log capture (which stays alive indefinitely)
    if (action !== "capture-console") {
      client.close();
    }
  }
}

main().catch(err => {
  console.error("Error executing action:", err.message);
  process.exit(1);
});
