/**
 * End-to-end test: drives a real VS Code Extension Development Host over Chrome
 * DevTools Protocol against a REAL ESP8266, verifying the full NodeMCU
 * workflow. The selectors and timings here were proven interactively first (see
 * .claude/SKILLS/devtools-automation/notes/nodemcu-e2e-flow.md).
 *
 * Scenarios:
 *   1. Initialize the project from the side-panel welcome button and wait for
 *      the auto-started first sync (claim/format/mirror, possibly build+flash)
 *      to finish, so later scenarios run against a quiescent extension.
 *   2. Select (and clear) a C module and a Lua module — assert ini + checkbox.
 *   3. Edit src/init.lua, save, and confirm the new file uploads AND runs
 *      (verified by reading the device's serial output directly).
 *   4. Enable the C `coap` module, save, and confirm build/flash runs and the
 *      boot banner advertises `coap`.
 *   5. Enable the Lua `fifo` module from the side panel and confirm it is usable
 *      in a Lua script after a plain save (no manual "Sync Lua Modules" step).
 *   6. Disable `fifo` and assert it is removed from the device.
 *
 * Requires hardware, so it only runs when NODEMCU_VSCODE_E2E_HARDWARE=1 and the
 * VS Code CLI exists; otherwise the suite is skipped (keeps `npm test` clean).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { SerialPort } from "serialport";

const PORT = process.env.NODEMCU_VSCODE_E2E_SERIAL_PORT || "COM7";
const BAUD_RATE = Number(process.env.NODEMCU_VSCODE_E2E_SERIAL_BAUD || "115200");
const DEBUG_PORT = Number(process.env.NODEMCU_VSCODE_E2E_CDP_PORT || "9240");
const RUN_ID = `${process.pid}-${Date.now()}`;
const WORKSPACE_DIR = path.join(os.tmpdir(), `nodemcu-vscode-e2e-ws-${RUN_ID}`);
const USER_DATA_DIR = path.join(os.tmpdir(), `nodemcu-vscode-e2e-ud-${RUN_ID}`);
const EXTENSIONS_DIR = path.join(os.tmpdir(), `nodemcu-vscode-e2e-ext-${RUN_ID}`);

const CODE_CMD =
  process.env.VSCODE_E2E_EXECUTABLE ||
  (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "bin", "code.cmd")
    : "/usr/bin/code");
const hasCode = fs.existsSync(CODE_CMD);
const DEFAULT_DISPLAY =
  process.platform === "linux" && !process.env.DISPLAY && fs.existsSync("/tmp/.X11-unix/X99") ? ":99" : process.env.DISPLAY;

const describe_ = process.env.NODEMCU_VSCODE_E2E_HARDWARE === "1" && hasCode ? describe : describe.skip;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Kill any orphaned Extension Development Host whose command line contains the
 * given marker. `code.cmd` returns immediately after spawning the real Code.exe,
 * so killing the cmd pid leaves the EDH alive holding the debug port — which
 * makes the next run connect to the stale window. Match on the unique marker.
 */
function killEdhByMarker(marker: string): void {
  if (process.platform !== "win32") {
    const result = child_process.spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf-8" });
    if (result.error || !result.stdout) return;
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2];
      if (!Number.isFinite(pid) || pid === process.pid || pid === process.ppid) continue;
      if (!command.includes(marker)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    return;
  }
  child_process.spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -match '${marker}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { encoding: "utf-8" },
  );
}

async function getDebuggerUrl(): Promise<string> {
  const workspaceMarker = path.basename(WORKSPACE_DIR);
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
      if (res.ok) {
        const targets = (await res.json()) as any[];
        const target = targets.find(
          (t) =>
            t.type === "page" &&
            t.title?.includes(workspaceMarker) &&
            (t.title?.includes("[Extension Development Host]") || t.title?.includes("nodemcu")),
        );
        if (target) return target.webSocketDebuggerUrl;
      }
    } catch {
      /* retry */
    }
    await sleep(1000);
  }
  throw new Error("Could not connect to EDH debugger port");
}

class CDPClient {
  ws: any = null;
  id = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  constructor(private wsUrl: string) {}

  async connect(): Promise<void> {
    this.ws = new (globalThis as any).WebSocket(this.wsUrl);
    this.ws.onmessage = (event: any) => {
      const data = JSON.parse(event.data);
      if (this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id)!;
        this.pending.delete(data.id);
        data.error ? reject(new Error(data.error.message || JSON.stringify(data.error))) : resolve(data.result);
      }
    };
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e: any) => reject(e);
    });
    await this.send("Runtime.enable");
  }
  send(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const msgId = this.id++;
      this.pending.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  async evaluate(expression: string): Promise<any> {
    const result: any = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Eval failed: ${result.exceptionDetails.exception?.description}`);
    return result.result.value;
  }
  close(): void {
    this.ws?.close();
  }
}

/**
 * Read the device's serial output after a reset and return matching lines.
 * The extension's shared serial session normally owns the port, so callers must
 * release it first (see withSerialReleased); opening still retries briefly
 * because the release lands asynchronously.
 */
async function readDeviceSerial(marker: string, timeoutMs = 12_000): Promise<{ found: boolean; lines: string[] }> {
  const lines: string[] = [];
  let buffer = "";
  let found = false;
  let sp: SerialPort | null = null;
  const openDeadline = Date.now() + 10_000;
  for (;;) {
    try {
      sp = await new Promise<SerialPort>((resolve, reject) => {
        const p = new SerialPort({ path: PORT, baudRate: BAUD_RATE }, (err) => (err ? reject(err) : resolve(p)));
      });
      break;
    } catch (e) {
      if (Date.now() >= openDeadline) {
        console.log(`[serial] open failed: ${(e as Error).message}`);
        return { found: false, lines };
      }
      await sleep(500);
    }
  }
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("latin1");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "").trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        lines.push(line);
        if (line.includes(marker)) found = true;
      }
    }
  };
  sp.on("data", onData);
  // Reset via restart command so init.lua re-runs and prints.
  await new Promise<void>((resolve) => sp!.write("\r\nnode.restart()\r\n", () => sp!.drain(() => resolve())));
  const started = Date.now();
  while (!found && Date.now() - started < timeoutMs) await sleep(300);
  await new Promise<void>((resolve) => (sp!.isOpen ? sp!.close(() => resolve()) : resolve()));
  await sleep(process.platform === "win32" ? 1200 : 250);
  return { found, lines };
}

async function readDeviceModules(timeoutMs = 20_000): Promise<{ modules: string[]; lines: string[] }> {
  const { lines } = await readDeviceSerial("modules:", timeoutMs);
  const text = lines.join("\n");
  const match = /modules:\s*([^\r\n]+)/i.exec(text);
  const modules = match
    ? match[1].split(/[;,\s]+/).map((m) => m.trim().toLowerCase()).filter(Boolean)
    : [];
  return { modules, lines };
}

describe_("NodeMCU e2e (CDP + hardware)", () => {
  let client: CDPClient;
  let codeProcess: child_process.ChildProcess;
  const extensionPath = path.resolve(__dirname, "../..");
  const iniPath = path.join(WORKSPACE_DIR, "nodemcu.ini");
  const initLuaPath = path.join(WORKSPACE_DIR, "src", "init.lua");

  beforeAll(async () => {
    // Clear any orphaned EDH from a previous run so the debug port is free.
    killEdhByMarker("nodemcu-vscode-e2e");
    await sleep(1500);
    for (const d of [WORKSPACE_DIR, USER_DATA_DIR, EXTENSIONS_DIR]) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
    }
    // Seed VS Code state to skip the first-run AI splash.
    const seed = path.join(process.env.APPDATA || "", "Code");
    try {
      fs.mkdirSync(path.join(USER_DATA_DIR, "User", "globalStorage"), { recursive: true });
      for (const rel of ["Local State", "User/globalStorage/state.vscdb", "User/globalStorage/storage.json"]) {
        const from = path.join(seed, rel);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(USER_DATA_DIR, rel));
      }
    } catch (e) {
      console.warn("seed state failed:", e);
    }

    codeProcess = child_process.spawn(
      `"${CODE_CMD}"`,
      [
        "--new-window",
        "--disable-workspace-trust",
        `--user-data-dir=${USER_DATA_DIR}`,
        `--extensions-dir=${EXTENSIONS_DIR}`,
        `--extensionDevelopmentPath=${extensionPath}`,
        `--remote-debugging-port=${DEBUG_PORT}`,
        WORKSPACE_DIR,
      ],
      {
        detached: false,
        shell: true,
        env: {
          ...process.env,
          ...(DEFAULT_DISPLAY ? { DISPLAY: DEFAULT_DISPLAY } : {}),
          NODEMCU_VSCODE_STORAGE_ROOT: process.env.NODEMCU_VSCODE_STORAGE_ROOT || path.join(os.homedir(), ".nodemcu-vscode"),
        },
      },
    );
    codeProcess.stderr?.on("data", (d) => console.log(`[vscode] ${d}`));

    const wsUrl = await getDebuggerUrl();
    client = new CDPClient(wsUrl);
    await client.connect();
    await sleep(2500); // let the extension activate
  }, 120_000);

  afterAll(() => {
    try {
      client?.close();
    } catch {
      /* ignore */
    }
    if (codeProcess?.pid) {
      if (process.platform === "win32") child_process.spawnSync("taskkill", ["/pid", String(codeProcess.pid), "/f", "/t"]);
      else codeProcess.kill();
    }
    // code.cmd orphans the real Code.exe; kill it by this run's unique dir.
    killEdhByMarker(`nodemcu-vscode-e2e-ud-${RUN_ID}`);
  });

  // ---- CDP helpers -------------------------------------------------------

  async function pressKey(vk: number, key: string, code: string, modifiers = 0): Promise<void> {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: vk, key, code, modifiers });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, key, code, modifiers });
  }
  const CTRL = process.platform === "darwin" ? 4 : 2;

  async function focusNodeMcuSidebar(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await client.evaluate(`
        (() => {
          const items = Array.from(document.querySelectorAll('.activitybar .action-item'));
          const it = items.find(e => /NodeMCU/i.test(e.getAttribute('aria-label') || (e.querySelector('a,.action-label')?.getAttribute('aria-label')) || ''));
          if (it) { const link = it.querySelector('a,.action-label') || it; const open = it.classList.contains('checked') || link.classList.contains('checked'); if (!open) link.click(); }
        })()
      `);
      await sleep(800);
      const ok = await client.evaluate(
        `(() => { const t = document.querySelector('.sidebar .composite.title, .sidebar .pane-header'); return !!t && /NodeMCU|Device Explorer|Lua Modules|C Modules/i.test(document.querySelector('.sidebar')?.textContent || ''); })()`,
      );
      if (ok) return;
    }
    throw new Error("NodeMCU sidebar did not open");
  }

  async function expandPanes(): Promise<void> {
    await client.evaluate(`(() => Array.from(document.querySelectorAll('.pane-header[aria-expanded="false"]')).forEach(h => h.click()))()`);
    await sleep(800);
  }

  async function clickWelcomeInitButton(): Promise<boolean> {
    return await client.evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('.welcome-view-content .monaco-button, .monaco-button, a.monaco-button'))
          .find(x => /initialize nodemcu project/i.test((x.textContent || '').trim()));
        if (!b) return false;
        b.click();
        return true;
      })()
    `);
  }

  /** Toggle a module checkbox by name in the given pane; returns the resulting checked state. */
  async function toggleModule(paneLabel: string, name: string): Promise<void> {
    const ok = await client.evaluate(`
      (() => {
        const pane = Array.from(document.querySelectorAll('.sidebar .pane'))
          .find(p => (p.querySelector('.pane-header')?.getAttribute('aria-label') || '').includes(${JSON.stringify(paneLabel)}));
        if (!pane) return 'no-pane';
        const row = Array.from(pane.querySelectorAll('.monaco-list-row')).find(r => r.textContent.trim().startsWith(${JSON.stringify(name)}));
        if (!row) return 'no-row';
        const cb = row.querySelector('.monaco-checkbox');
        if (!cb) return 'no-cb';
        cb.click();
        return 'ok';
      })()
    `);
    if (ok !== "ok") throw new Error(`toggleModule(${paneLabel}, ${name}) failed: ${ok}`);
    await sleep(1200);
  }

  async function moduleChecked(paneLabel: string, name: string): Promise<boolean | string> {
    return await client.evaluate(`
      (() => {
        const pane = Array.from(document.querySelectorAll('.sidebar .pane'))
          .find(p => (p.querySelector('.pane-header')?.getAttribute('aria-label') || '').includes(${JSON.stringify(paneLabel)}));
        if (!pane) return 'no-pane';
        const row = Array.from(pane.querySelectorAll('.monaco-list-row')).find(r => r.textContent.trim().startsWith(${JSON.stringify(name)}));
        if (!row) return 'no-row';
        const cb = row.querySelector('.monaco-checkbox');
        return cb ? cb.classList.contains('checked') : 'no-cb';
      })()
    `);
  }

  async function clickAt(x: number, y: number): Promise<void> {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async function activeTabName(): Promise<string> {
    return await client.evaluate(
      `(() => { const t = document.querySelector('.tab.active') || document.querySelector('.tab[aria-selected="true"]'); return t ? (t.getAttribute('aria-label') || t.textContent || '').trim() : ''; })()`,
    );
  }

  async function openFile(name: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await pressKey(0x1b, "Escape", "Escape");
      await sleep(200);
      await pressKey(0x50, "p", "KeyP", CTRL); // Ctrl+P quick open
      await sleep(700);
      await client.evaluate(
        `(() => { const i = document.querySelector('.quick-input-box input'); i.focus(); i.value = ${JSON.stringify(name)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await sleep(900);
      await pressKey(0x0d, "Enter", "Enter");
      await sleep(900);
      if ((await activeTabName()).includes(name)) return;
    }
    throw new Error(`Could not open ${name}; active tab is ${await activeTabName()}`);
  }

  /** Click the active editor surface so keyboard input lands in Monaco. */
  async function focusActiveEditor(): Promise<void> {
    const target = (await client.evaluate(`
      (() => {
        const group = Array.from(document.querySelectorAll('.editor-group-container')).find(g => g.classList.contains('active')) || document.querySelector('.editor-group-container');
        const editor = (group || document).querySelector('.monaco-editor');
        const surface = editor?.querySelector('.view-lines') || editor;
        if (!surface) return null;
        const r = surface.getBoundingClientRect();
        return { x: r.left + Math.min(60, r.width / 3), y: r.top + Math.min(20, r.height / 3) };
      })()
    `)) as { x: number; y: number } | null;
    if (!target) throw new Error("No active editor to focus");
    await clickAt(target.x, target.y);
    await sleep(250);
  }

  async function activeEditorText(): Promise<string> {
    return await client.evaluate(`
      (() => {
        const group = Array.from(document.querySelectorAll('.editor-group-container')).find(g => g.classList.contains('active')) || document.querySelector('.editor-group-container');
        const editor = (group || document).querySelector('.monaco-editor');
        const lines = editor ? Array.from(editor.querySelectorAll('.view-lines .view-line')) : [];
        return lines.map(l => (l.textContent || '').replace(/\\u00a0/g, ' ')).join('\\n');
      })()
    `);
  }

  async function setEditorText(text: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await focusActiveEditor();
      await pressKey(0x41, "a", "KeyA", CTRL); // Ctrl+A
      await sleep(150);
      await client.send("Input.insertText", { text });
      await sleep(300);
      if ((await activeEditorText()).includes(text)) return;
    }
    throw new Error(`Editor text did not update. Wanted: ${text}\nGot: ${await activeEditorText()}`);
  }

  async function saveEditor(): Promise<void> {
    await focusActiveEditor();
    await pressKey(0x53, "s", "KeyS", CTRL); // Ctrl+S
    await sleep(400);
  }

  /** Edit init.lua in the editor, save, and confirm the change reached disk. */
  async function editAndSaveInitLua(content: string): Promise<void> {
    await openFile("init.lua");
    await setEditorText(content);
    await clearToasts(); // drop stale toasts so waitForUpload sees only this op
    await saveEditor();
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(initLuaPath) && fs.readFileSync(initLuaPath, "utf-8").includes(content)) return;
      await sleep(300);
    }
    throw new Error(`init.lua on disk did not receive the edit. Disk: ${fs.existsSync(initLuaPath) ? fs.readFileSync(initLuaPath, "utf-8") : "(missing)"}`);
  }

  async function getToasts(): Promise<string[]> {
    return await client.evaluate(`
      (() => Array.from(document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notification-toast'))
        .map(e => (e.textContent || '').trim().replace(/\\s+/g, ' ')).filter(Boolean))()
    `);
  }

  async function clickProceedIfPresent(): Promise<boolean> {
    return await client.evaluate(`
      (() => { const b = Array.from(document.querySelectorAll('.monaco-button')).find(x => /^proceed$/i.test((x.textContent || '').trim())); if (b) { b.click(); return true; } return false; })()
    `);
  }

  /** Run a command-palette command by label (F1 → type → Enter). */
  async function runPaletteCommand(label: string): Promise<void> {
    await pressKey(0x1b, "Escape", "Escape");
    await sleep(150);
    await pressKey(0x70, "F1", "F1");
    await sleep(600);
    await client.evaluate(
      `(() => { const i = document.querySelector('.quick-input-box input'); i.focus(); i.value = ${JSON.stringify(`>${label}`)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    await sleep(700);
    await pressKey(0x0d, "Enter", "Enter");
    await sleep(400);
  }

  /** Clear lingering notification toasts so the next upload's toasts are unambiguous. */
  async function clearToasts(): Promise<void> {
    await runPaletteCommand("Clear All Notifications");
  }

  /**
   * The extension's shared serial session owns the port, so a direct SerialPort
   * read gets "Access denied". Release the port for the duration of fn, then
   * hand ownership back so later uploads keep working. Proven interactively:
   * Release Serial Port frees the port within ~3s, Reconnect re-claims it.
   */
  async function withSerialReleased<T>(fn: () => Promise<T>): Promise<T> {
    await runPaletteCommand("NodeMCU: Release Serial Port");
    try {
      return await fn();
    } finally {
      await runPaletteCommand("NodeMCU: Reconnect Serial Port");
      await sleep(1500);
    }
  }

  /**
   * Wait for an upload/sync to complete, clicking the device-claim "Proceed"
   * prompt the first time it appears. Resolves with the final toast text.
   */
  async function waitForUpload(timeoutMs: number): Promise<string> {
    const started = Date.now();
    let claimed = false;
    let sawActive = false;
    let lastJoined = "";
    const history: string[] = [];
    while (Date.now() - started < timeoutMs) {
      if (!claimed && (await clickProceedIfPresent())) claimed = true;
      const joined = (await getToasts()).join(" | ");
      if (joined && joined !== lastJoined) {
        history.push(joined);
        lastJoined = joined;
      }
      if (/uploading|syncing|formatting|removing|building|flashing/i.test(joined)) sawActive = true;
      if (/FAILED|failed to|Unable to|aborted/i.test(joined)) throw new Error(`Upload failed. Toasts: ${history.join(" || ")}`);
      // Require having seen the new operation's active phase before accepting a
      // success toast, so a lingering success toast can't satisfy us early.
      if (sawActive && /(synced \d+ operation|uploaded )/i.test(joined)) return history.join(" || ");
      await sleep(400);
    }
    throw new Error(`Timed out waiting for upload result. Toasts: ${history.join(" || ") || (await getToasts()).join(" | ")}`);
  }

  function readIni(): string {
    return fs.existsSync(iniPath) ? fs.readFileSync(iniPath, "utf-8") : "";
  }

  // ---- Scenarios ---------------------------------------------------------

  it("1. initializes the project and completes the initial device sync", async () => {
    await focusNodeMcuSidebar();
    let clicked = false;
    for (let i = 0; i < 10 && !clicked; i++) {
      clicked = await clickWelcomeInitButton();
      if (!clicked) await sleep(500);
    }
    expect(clicked, "welcome 'Initialize NodeMCU Project' button present and clicked").toBe(true);

    for (let i = 0; i < 30 && !fs.existsSync(iniPath); i++) await sleep(1000);
    expect(fs.existsSync(iniPath), "nodemcu.ini created").toBe(true);
    expect(fs.existsSync(initLuaPath), "src/init.lua created").toBe(true);
    // Port auto-detected and written (may land a moment after the ini is created).
    const escapedPort = PORT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const portPattern = new RegExp(`port\\s*=\\s*${escapedPort}`, "i");
    for (let i = 0; i < 15 && !portPattern.test(readIni()); i++) await sleep(1000);
    expect(readIni()).toMatch(portPattern);

    const timestampPattern = /^last_timestamp[ \t]*=[ \t]*\S/im;
    expect(timestampPattern.test(readIni()), "initialize should not sync automatically. ini: " + readIni()).toBe(false);
  }, 60_000);

  it("2. selects and clears a C module and a Lua module (ini + checkbox round-trip)", async () => {
    await focusNodeMcuSidebar();
    await expandPanes();

    // C module: enable coap, assert; then disable, assert.
    await toggleModule("C Modules", "coap");
    expect(readIni()).toMatch(/coap\s*=\s*true/i);
    expect(await moduleChecked("C Modules", "coap")).toBe(true);
    await toggleModule("C Modules", "coap");
    expect(readIni()).toMatch(/coap\s*=\s*false/i);
    expect(await moduleChecked("C Modules", "coap")).toBe(false);

    // Lua module: enable bh1750, assert; then disable, assert.
    await toggleModule("Lua Modules", "bh1750");
    expect(readIni()).toMatch(/^bh1750\s*=/im);
    expect(await moduleChecked("Lua Modules", "bh1750")).toBe(true);
    await toggleModule("Lua Modules", "bh1750");
    expect(readIni()).not.toMatch(/^bh1750\s*=/im);
    expect(await moduleChecked("Lua Modules", "bh1750")).toBe(false);
  }, 60_000);

  it("3. edits init.lua, uploads on save, and the new file runs on the device", async () => {
    const marker = `HELLO_E2E_${RUN_ID.replace(/[^a-zA-Z0-9]/g, "")}`;
    await editAndSaveInitLua(`print("${marker}")`);
    // Initialization only creates the project. The first save owns the initial
    // full mirror (and any required build/flash), so give it the hardware
    // path timeout rather than the later fast single-file timeout.
    const result = await waitForUpload(900_000);
    expect(result).toMatch(/synced \d+ operation|uploaded/i);

    const { found, lines } = await withSerialReleased(() => readDeviceSerial(marker, 15_000));
    expect(found, `device serial should print ${marker}. Lines: ${lines.slice(-8).join(" / ")}`).toBe(true);
  }, 960_000);

  it("4. enabling the coap C module rebuilds/flashes and the boot banner lists it", async () => {
    await focusNodeMcuSidebar();
    await expandPanes();
    if ((await moduleChecked("C Modules", "coap")) !== true) await toggleModule("C Modules", "coap");
    expect(readIni()).toMatch(/coap\s*=\s*true/i);

    const marker = `COAP_REBUILD_${RUN_ID.replace(/[^a-zA-Z0-9]/g, "")}`;
    await editAndSaveInitLua(`print("${marker}")`);
    const result = await waitForUpload(900_000);
    expect(result).toMatch(/building/i);
    expect(result).toMatch(/flashing/i);
    expect(result).toMatch(/uploaded|synced/i);

    const { modules, lines } = await withSerialReleased(() => readDeviceModules(30_000));
    expect(modules, `boot banner modules should include coap. Lines: ${lines.slice(-12).join(" / ")}`).toContain("coap");
  }, 960_000);

  it("5. enabling the fifo Lua module makes it usable after a plain save (no manual sync)", async () => {
    await focusNodeMcuSidebar();
    await expandPanes();
    if ((await moduleChecked("Lua Modules", "fifo")) !== true) await toggleModule("Lua Modules", "fifo");
    expect(readIni()).toMatch(/^fifo\s*=/im);

    await editAndSaveInitLua(`local ok,m = pcall(require, "fifo"); print("FIFO_OK", ok, type(m))`);
    const result = await waitForUpload(90_000);
    expect(result).toMatch(/uploaded|synced/i);

    const { found, lines } = await withSerialReleased(() => readDeviceSerial("FIFO_OK", 15_000));
    expect(found, "FIFO_OK printed").toBe(true);
    const fifoLine = lines.find((l) => l.includes("FIFO_OK")) || "";
    expect(fifoLine, `fifo should load (true table). Got: ${fifoLine}`).toMatch(/FIFO_OK\s+true\s+table/i);
  }, 120_000);

  it("6. disabling the fifo module removes it from the device", async () => {
    await focusNodeMcuSidebar();
    await expandPanes();
    if ((await moduleChecked("Lua Modules", "fifo")) === true) await toggleModule("Lua Modules", "fifo");
    expect(readIni(), "fifo removed from ini").not.toMatch(/^fifo\s*=/im);
    expect(await moduleChecked("Lua Modules", "fifo")).toBe(false);

    // Save to push the removal; reconcile deletes fifo.lc from the device.
    await editAndSaveInitLua(`local ok,m = pcall(require, "fifo"); print("FIFO_GONE", ok, type(m))`);
    const result = await waitForUpload(90_000);
    expect(result).toMatch(/uploaded|synced/i);

    const { found, lines } = await withSerialReleased(() => readDeviceSerial("FIFO_GONE", 15_000));
    expect(found, "FIFO_GONE printed").toBe(true);
    const line = lines.find((l) => l.includes("FIFO_GONE")) || "";
    expect(line, `require('fifo') should now fail. Got: ${line}`).toMatch(/FIFO_GONE\s+false/i);
  }, 120_000);
});
