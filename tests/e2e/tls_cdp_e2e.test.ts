/**
 * End-to-end test: drives a real VS Code Extension Development Host over Chrome
 * DevTools Protocol against a REAL ESP8266, exercising the TLS path through the
 * actual extension UI pipeline (companion to the headless tls_buffer_size_e2e).
 *
 * Flow:
 *   1. Initialize the project from the side-panel welcome button (lua51).
 *   2. Enable the `tls` core C module and a target `ssl_buffer_size` in nodemcu.ini.
 *   3. Write a TLS init.lua (Wi-Fi join + one HTTPS GET) and drive the extension's
 *      "Build & Flash" command: build the tls firmware → flash → mirror src/.
 *   4. Shut the EDH down to free the serial port, reset the device, and read its
 *      serial output directly, asserting the HTTPS request returned a real status
 *      code (i.e. the TLS handshake completed at the configured buffer size).
 *
 * Requires hardware + Wi-Fi, so it only runs when NODEMCU_VSCODE_E2E_HARDWARE=1,
 * the VS Code CLI exists, and NODEMCU_VSCODE_E2E_WIFI_SSID is set; otherwise the
 * suite is skipped (keeps `npm test` clean). No credentials are hardcoded.
 *
 * Env:
 *   NODEMCU_VSCODE_E2E_HARDWARE=1            (required)
 *   NODEMCU_VSCODE_E2E_WIFI_SSID=<ssid>      (required)
 *   NODEMCU_VSCODE_E2E_WIFI_PASS             (default "" — open network)
 *   NODEMCU_VSCODE_E2E_SSL_SIZE              (default 8192)
 *   NODEMCU_VSCODE_E2E_TLS_URL               (default https://example.com/)
 *   NODEMCU_VSCODE_E2E_SERIAL_PORT           (default /dev/ttyUSB0 or COM7)
 *   NODEMCU_VSCODE_E2E_SERIAL_BAUD           (default 460800 — the template baud)
 *   VSCODE_E2E_EXECUTABLE                    (path to the `code` CLI)
 * On headless Linux the EDH is launched with --no-sandbox (handled in beforeAll).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { SerialPort } from "serialport";

const PORT = process.env.NODEMCU_VSCODE_E2E_SERIAL_PORT || (process.platform === "win32" ? "COM7" : "/dev/ttyUSB0");
// The device REPL runs at the baud the extension's Initialize Project writes
// (resources/templates/nodemcu.ini → 460800), NOT the 115200 console default, so a
// direct serial read must use 460800 or it gets only garbage/empty lines. Override
// with NODEMCU_VSCODE_E2E_SERIAL_BAUD if the template baud changes.
const BAUD_RATE = Number(process.env.NODEMCU_VSCODE_E2E_SERIAL_BAUD || "460800");
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

const describe_ =
  process.env.NODEMCU_VSCODE_E2E_HARDWARE === "1" && hasCode && (process.env.NODEMCU_VSCODE_E2E_WIFI_SSID || "").length > 0
    ? describe
    : describe.skip;

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


let lastSerialOpenError = "";

async function canOpenSerialPort(): Promise<boolean> {
  let sp: SerialPort | null = null;
  try {
    sp = await new Promise<SerialPort>((resolve, reject) => {
      const p = new SerialPort({ path: PORT, baudRate: BAUD_RATE }, (err) => (err ? reject(err) : resolve(p)));
    });
    return true;
  } catch (e) {
    lastSerialOpenError = (e as Error).message;
    return false;
  } finally {
    if (sp?.isOpen) {
      await new Promise<void>((resolve) => sp!.close(() => resolve()));
      await sleep(process.platform === "win32" ? 1200 : 250);
    }
  }
}

async function waitForSerialPortAvailable(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canOpenSerialPort()) return true;
    await sleep(750);
  }
  return false;
}

describe_("NodeMCU TLS over EDH (CDP + hardware)", () => {
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
        // Linux CI/headless hosts often lack the user-namespace sandbox Electron
        // needs; without --no-sandbox the renderer never starts and the remote
        // debugging port never serves a page (getDebuggerUrl times out).
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
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





  /** Click the active editor surface so keyboard input lands in Monaco. */




  /** Close the secondary side bar (Chat) so it cannot steal keyboard focus. */

  /** Edit init.lua in the editor, save, and confirm the change reached disk. */

  async function getToasts(): Promise<string[]> {
    return await client.evaluate(`
      (() => Array.from(document.querySelectorAll('.notifications-toasts .notification-list-item-message, .notifications-list-container .notification-list-item-message'))
        .map(e => (e.textContent || '').trim().replace(/\\s+/g, ' ')).filter(Boolean))()
    `);
  }

  async function clickProceedIfPresent(): Promise<boolean> {
    return await client.evaluate(`
      (() => { const b = Array.from(document.querySelectorAll('.monaco-button')).find(x => /^proceed$/i.test((x.textContent || '').trim())); if (b) { b.click(); return true; } return false; })()
    `);
  }

  /** Run a command-palette command by label (F1 → type → Enter). Hardened for

  /** Clear lingering notification toasts so the next upload's toasts are unambiguous. */



  function readIni(): string {
    return fs.existsSync(iniPath) ? fs.readFileSync(iniPath, "utf-8") : "";
  }

  /** Enable tls (+http/net/wifi deps) in [c_modules] and force ssl_buffer_size, in
   *  one ini write so the config watcher reloads a single consistent state. tls is a
   *  core C module (not in the optional checkbox list), so it is set on disk directly. */
  function enableTlsInIni(size: number): void {
    let ini = readIni();
    for (const mod of ["tls", "http", "net", "wifi"]) {
      if (new RegExp(`^${mod}\\s*=`, "im").test(ini)) ini = ini.replace(new RegExp(`^${mod}\\s*=.*$`, "im"), `${mod}=true`);
      else ini = ini.replace(/^\[c_modules\]/im, `[c_modules]\n${mod}=true`);
    }
    if (/ssl_buffer_size\s*=/.test(ini)) ini = ini.replace(/ssl_buffer_size\s*=.*$/im, `ssl_buffer_size=${size}`);
    else if (/^\[build\]/im.test(ini)) ini = ini.replace(/^\[build\]/im, `[build]\nssl_buffer_size=${size}`);
    else ini += `\n[build]\nssl_buffer_size=${size}\n`;
    fs.writeFileSync(iniPath, ini, "utf-8");
  }

  const WIFI_SSID = process.env.NODEMCU_VSCODE_E2E_WIFI_SSID || "";
  const WIFI_PASS = process.env.NODEMCU_VSCODE_E2E_WIFI_PASS ?? "";
  const SSL_SIZE = Number(process.env.NODEMCU_VSCODE_E2E_SSL_SIZE || "8192");
  const TLS_ENDPOINT = process.env.NODEMCU_VSCODE_E2E_TLS_URL || "https://example.com/";

  /** init.lua that joins Wi-Fi and does one HTTPS GET, printing TLS<size>_OK <code> <len>.
   *  Emitted as a SINGLE line: Monaco auto-indents multiline Lua, and this also keeps
   *  the on-disk file trivial. Lua statements separate on spaces. */
  function tlsInitLua(): string {
    const q = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    return (
      `print("TLS${SSL_SIZE}_RUN") ` +
      `wifi.setmode(wifi.STATION) ` +
      `wifi.sta.config({ssid=${q(WIFI_SSID)},pwd=${q(WIFI_PASS)},auto=true}) ` +
      `local done=false ` +
      `local function go(ip) if done then return end done=true ` +
      `print("TLS${SSL_SIZE}_IP "..ip) ` +
      `http.get(${q(TLS_ENDPOINT)},nil,function(code,data) ` +
      `print("TLS${SSL_SIZE}_OK "..string.format("%d",code).." "..string.format("%d",data and #data or 0)) end) end ` +
      `wifi.eventmon.register(wifi.eventmon.STA_GOT_IP,function(T) go(T.IP) end) ` +
      `local cur=wifi.sta.getip() if cur then go(cur) end`
    );
  }

  // ---- Scenario: TLS over the real EDH pipeline at a given ssl_buffer_size ----

  it(`drives EDH to build/flash lua51+tls (ssl_buffer_size=${SSL_SIZE}) and completes a real HTTPS handshake over ${WIFI_SSID || "<wifi>"}`, async () => {
    expect(WIFI_SSID.length, "set NODEMCU_VSCODE_E2E_WIFI_SSID").toBeGreaterThan(0);

    // 1. Initialize the project from the side-panel welcome button.
    await focusNodeMcuSidebar();
    let clicked = false;
    for (let i = 0; i < 10 && !clicked; i++) {
      clicked = await clickWelcomeInitButton();
      if (!clicked) await sleep(500);
    }
    expect(clicked, "welcome 'Initialize NodeMCU Project' button present and clicked").toBe(true);
    for (let i = 0; i < 30 && !fs.existsSync(iniPath); i++) await sleep(1000);
    expect(fs.existsSync(iniPath), "nodemcu.ini created").toBe(true);
    expect(readIni()).toMatch(/lua_version\s*=\s*51/i);

    // 2. Enable tls (core C module, set on disk) + force the buffer size in one ini
    //    write; let the config watcher reload it.
    enableTlsInIni(SSL_SIZE);
    await sleep(2000);
    expect(readIni(), "tls enabled in ini").toMatch(/tls\s*=\s*true/i);
    expect(readIni()).toMatch(new RegExp(`ssl_buffer_size\\s*=\\s*${SSL_SIZE}`, "i"));

    // 3. Write the TLS init.lua to disk and drive Build & Flash from the palette.
    //    Headless EDH steals editor focus unreliably, so the editor-typing path is
    //    avoided; the palette Enter is retried until the command actually starts (a
    //    toast appears), which fixes the "palette open but never committed" wedge.
    fs.mkdirSync(path.dirname(initLuaPath), { recursive: true });
    fs.writeFileSync(initLuaPath, tlsInitLua(), "utf-8");
    // Trigger Build & Flash via its keybinding (Ctrl+Alt+B). This is deterministic
    // and avoids the headless command-palette Enter-commit flakiness (the palette
    // can stay open without committing the command). Ensure the workbench (not an
    // input) has focus first. Modifiers bitmask: Alt=1, Ctrl=2 → Ctrl+Alt=3. The
    // start probe matches only build/flash toasts (not the auto "Sync src/") so a
    // stray sync can't be mistaken for the command having started.
    await focusNodeMcuSidebar();
    let started = false;
    for (let attempt = 0; attempt < 10 && !started; attempt++) {
      await pressKey(0x1b, "Escape", "Escape");
      await sleep(150);
      await pressKey(0x42, "b", "KeyB", 3); // Ctrl+Alt+B
      for (let i = 0; i < 12 && !started; i++) {
        const toasts = (await getToasts()).join(" | ");
        if (/build & flash queued|building|configuring|flashing|build ok|flashed/i.test(toasts)) started = true;
        else await sleep(500);
      }
    }
    expect(started, "Build & Flash (Ctrl+Alt+B) should start (toast appeared)").toBe(true);

    // 4. Wait for the FULL pipeline: build → flash done → post-flash mirror. A
    //    lingering auto "Sync src/" success toast can otherwise satisfy a generic
    //    "synced" wait mid-build, so key completion on the flash-done toast and
    //    require a sync/upload AFTER it.
    // Completion is keyed on the extension persisting a NEW [sync] last_timestamp
    // to nodemcu.ini AFTER the flash. Flashing formats SPIFFS, so the post-flash
    // mirror must re-upload init.lua and then writes a fresh timestamp; that file
    // write is durable (unlike the transient success toast a poll can miss), so it
    // reliably means init.lua actually landed on the device before we shut the EDH
    // down to read serial.
    const syncTs = () => (/^\s*last_timestamp\s*=\s*(\S+)/im.exec(readIni())?.[1] ?? "");
    const tsBeforeFlash = syncTs();
    const history: string[] = [];
    let sawBuilding = false;
    let sawFlashed = false;
    let done = false;
    let lastJoined = "";
    let claimed = false;
    const deadline = Date.now() + 900_000;
    while (!done && Date.now() < deadline) {
      if (!claimed && (await clickProceedIfPresent())) claimed = true;
      const joined = (await getToasts()).join(" | ");
      if (joined && joined !== lastJoined) {
        history.push(joined);
        lastJoined = joined;
      }
      if (/building|build ok|build succeeded/i.test(joined)) sawBuilding = true;
      if (/build failed|flash failed|failed to flash|aborted/i.test(joined))
        throw new Error(`Build/flash failed. Toasts: ${history.join(" || ")}`);
      if (/flashed \/dev|flashed .*in \d+ms/i.test(joined)) sawFlashed = true;
      // Post-flash mirror finished when a new sync timestamp is on disk.
      const ts = syncTs();
      if (sawFlashed && ts && ts !== tsBeforeFlash) done = true;
      await sleep(400);
    }
    const result = history.join(" || ");
    expect(sawBuilding, `build should run. Toasts: ${result}`).toBe(true);
    expect(sawFlashed, `flash should complete. Toasts: ${result}`).toBe(true);
    expect(done, `post-flash mirror should persist a new sync timestamp. Toasts: ${result}`).toBe(true);
    // The mirror's last serial chatter can still be settling; let it drain before
    // we seize the port.
    await sleep(3000);

    // 5. The EDH has done its job (firmware flashed, init.lua mirrored). Reading the
    //    device serial back through "Release Serial Port" is unreliable headless (the
    //    palette Enter and the native port lock race), so deterministically free the
    //    port by shutting the EDH down, then read serial directly. Reset re-runs
    //    init.lua → Wi-Fi join + HTTPS.
    const marker = `TLS${SSL_SIZE}_OK`;
    client?.close();
    killEdhByMarker(`nodemcu-vscode-e2e-ud-${RUN_ID}`);
    const free = await waitForSerialPortAvailable(45_000);
    expect(free, `serial port ${PORT} should free after EDH shutdown (last: ${lastSerialOpenError})`).toBe(true);
    const { found, lines } = await readDeviceSerial(marker, 120_000);
    const okLine = lines.find((l) => l.includes(marker)) || "";
    process.stdout.write(`[tls-cdp] lines: ${lines.slice(-10).join(" / ")}\n`);
    expect(found, `device should print ${marker} (TLS handshake @${SSL_SIZE}). Lines: ${lines.slice(-10).join(" / ")}`).toBe(true);
    const m = new RegExp(`${marker}\\s+(-?\\d+)\\s+(\\d+)`).exec(okLine);
    expect(m, `result line malformed: ${okLine}`).not.toBeNull();
    const code = Number(m![1]);
    expect(code, `HTTPS status should be a real HTTP code (handshake done) @${SSL_SIZE}, got ${code}`).toBeGreaterThanOrEqual(200);
    expect(code).toBeLessThan(600);
  }, 1_080_000);
});
