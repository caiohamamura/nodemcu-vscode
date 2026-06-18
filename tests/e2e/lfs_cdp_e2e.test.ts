/**
 * End-to-end test: drives a real VS Code Extension Development Host over Chrome
 * DevTools Protocol against a REAL ESP8266, exercising the LFS (Lua Flash Store)
 * UI flow end to end:
 *
 *   1. The LFS commands are gated on a host C compiler — the command palette
 *      lists "NodeMCU: Enable LFS (Lua Flash Store)" only because the extension
 *      detected `cc`/`gcc` and set the `nodemcu.hasHostCompiler` context key.
 *   2. Running "NodeMCU: Enable LFS" writes `[build] lfs_size`, rebuilds + flashes
 *      firmware with the LFS partition, compiles the project's Lua into an LFS
 *      image, uploads it, and `node.flashreload`s it. The toast reports the
 *      deploy, and on the device the module resolves from flash
 *      (`node.flashindex` / `node.LFS.list`) and runs.
 *
 * Selectors/timings were proven interactively first (AGENTS §9.8) against a live
 * EDH before being encoded here.
 *
 * Requires hardware + a host C compiler + the VS Code CLI, so it only runs when
 * NODEMCU_VSCODE_E2E_HARDWARE=1 (otherwise skipped). The firmware build needs
 * cmake — either on PATH (e.g. linuxbrew) or the extension's managed cmake.
 *
 * Required env:
 *   NODEMCU_VSCODE_E2E_HARDWARE=1
 * Optional env:
 *   NODEMCU_VSCODE_E2E_SERIAL_PORT     (default /dev/ttyUSB0 or COM7)
 *   NODEMCU_VSCODE_E2E_SERIAL_BAUD     (default 115200)
 *   NODEMCU_VSCODE_E2E_CDP_PORT        (default 9242)
 *   NODEMCU_VSCODE_LFS_FIRMWARE_PATH   (firmware_path written to the seeded ini;
 *                                       reuse a built checkout to skip download)
 *   NODEMCU_VSCODE_LFS_LUA             (51 or 53, default 53)
 *   VSCODE_E2E_EXECUTABLE              (path to the code CLI)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { SerialPort } from "serialport";

const PORT = process.env.NODEMCU_VSCODE_E2E_SERIAL_PORT || (process.platform === "win32" ? "COM7" : "/dev/ttyUSB0");
const BAUD_RATE = Number(process.env.NODEMCU_VSCODE_E2E_SERIAL_BAUD || "115200");
const DEBUG_PORT = Number(process.env.NODEMCU_VSCODE_E2E_CDP_PORT || "9242");
const LFS_LUA = (process.env.NODEMCU_VSCODE_LFS_LUA as "51" | "53") || "53";
const LFS_FIRMWARE_PATH = process.env.NODEMCU_VSCODE_LFS_FIRMWARE_PATH || "";
const MODULE = "greet";
const RUN_ID = `${process.pid}-${Date.now()}`;
const WORKSPACE_DIR = path.join(os.tmpdir(), `nodemcu-vscode-lfscdp-ws-${RUN_ID}`);
const USER_DATA_DIR = path.join(os.tmpdir(), `nodemcu-vscode-lfscdp-ud-${RUN_ID}`);
const EXTENSIONS_DIR = path.join(os.tmpdir(), `nodemcu-vscode-lfscdp-ext-${RUN_ID}`);

const CODE_CMD =
  process.env.VSCODE_E2E_EXECUTABLE ||
  (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "bin", "code.cmd")
    : "/usr/bin/code");
const hasCode = fs.existsSync(CODE_CMD);
function hasHostCompiler(): boolean {
  for (const c of ["cc", "gcc", "clang"]) {
    const r = child_process.spawnSync(process.platform === "win32" ? "where" : "which", [c], { encoding: "utf-8" });
    if (r.status === 0 && (r.stdout || "").trim()) return true;
  }
  return false;
}
const DEFAULT_DISPLAY =
  process.platform === "linux" && !process.env.DISPLAY && fs.existsSync("/tmp/.X11-unix/X99") ? ":99" : process.env.DISPLAY;

const describe_ =
  process.env.NODEMCU_VSCODE_E2E_HARDWARE === "1" && hasCode && hasHostCompiler() ? describe : describe.skip;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function killEdhByMarker(marker: string): void {
  if (process.platform !== "win32") {
    const result = child_process.spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf-8" });
    if (result.error || !result.stdout) return;
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isFinite(pid) || pid === process.pid || pid === process.ppid) continue;
      if (!match[2].includes(marker)) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
}

async function getDebuggerUrl(): Promise<string> {
  const marker = path.basename(WORKSPACE_DIR);
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (res.ok) {
        const targets = (await res.json()) as any[];
        const target = targets.find(
          (t) => t.type === "page" && (t.title?.includes(marker) || t.title?.includes("[Extension Development Host]")),
        );
        if (target) return target.webSocketDebuggerUrl;
      }
    } catch { /* retry */ }
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
  close(): void { this.ws?.close(); }
}

/** Read the device's serial output (after release) and return matching lines. */
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
      if (Date.now() >= openDeadline) return { found: false, lines };
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
  // Send the probe (one chunk per line; device locals don't persist across lines).
  const probe = [
    `print("VCHK inflash="..type(node.flashindex("${MODULE}")))`,
    `print("VSPIFFS="..tostring(file.exists("${MODULE}.lc") or file.exists("${MODULE}.lua")))`,
    `local f=node.flashindex("${MODULE}") print("VPING="..tostring(f and f().hi()))`,
    `local l=node.LFS.list() if l then for _,n in ipairs(l) do print("VMOD="..n) end end`,
  ];
  await new Promise<void>((r) => sp!.write("\r\n", () => sp!.drain(() => r())));
  await sleep(300);
  for (const line of probe) {
    await new Promise<void>((r) => sp!.write(line + "\r\n", () => sp!.drain(() => r())));
    await sleep(250);
  }
  const started = Date.now();
  while (!found && Date.now() - started < timeoutMs) await sleep(300);
  await new Promise<void>((resolve) => (sp!.isOpen ? sp!.close(() => resolve()) : resolve()));
  await sleep(process.platform === "win32" ? 1200 : 250);
  return { found, lines };
}

async function canOpenSerialPort(): Promise<boolean> {
  let sp: SerialPort | null = null;
  try {
    sp = await new Promise<SerialPort>((resolve, reject) => {
      const p = new SerialPort({ path: PORT, baudRate: BAUD_RATE }, (err) => (err ? reject(err) : resolve(p)));
    });
    return true;
  } catch {
    return false;
  } finally {
    if (sp?.isOpen) {
      await new Promise<void>((resolve) => sp!.close(() => resolve()));
      await sleep(process.platform === "win32" ? 1200 : 250);
    }
  }
}

describe_("NodeMCU LFS e2e (CDP + hardware)", () => {
  let client: CDPClient;
  let codeProcess: child_process.ChildProcess;
  const extensionPath = path.resolve(__dirname, "../..");
  const iniPath = path.join(WORKSPACE_DIR, "nodemcu.ini");

  beforeAll(async () => {
    killEdhByMarker("nodemcu-vscode-lfscdp");
    await sleep(1500);
    for (const d of [WORKSPACE_DIR, USER_DATA_DIR, EXTENSIONS_DIR]) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.mkdirSync(d, { recursive: true });
    }
    fs.mkdirSync(path.join(WORKSPACE_DIR, "src"), { recursive: true });
    fs.mkdirSync(path.join(WORKSPACE_DIR, ".vscode"), { recursive: true });
    // Seed a project: firmware_path (optional reuse), Lua version, port, a sample
    // module, and an init.lua that loads the module from flash via flashindex.
    fs.writeFileSync(
      iniPath,
      [
        "[nodemcu]",
        ...(LFS_FIRMWARE_PATH ? [`firmware_path=${LFS_FIRMWARE_PATH}`] : []),
        `lua_version=${LFS_LUA}`,
        `port=${PORT}`,
        `baud=${BAUD_RATE}`,
        "src=src",
        "",
        "[c_modules]",
        ...["file", "gpio", "net", "node", "tmr", "uart", "wifi"].map((m) => `${m}=true`),
        "",
        "[build]",
        "lfs_size=0",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(path.join(WORKSPACE_DIR, "src", `${MODULE}.lua`), `local M = {} function M.hi() return "lfs-cdp-ok" end return M\n`, "utf-8");
    fs.writeFileSync(
      path.join(WORKSPACE_DIR, "src", "init.lua"),
      `local f = node.flashindex and node.flashindex("${MODULE}")\nprint("CDP_LFS hi="..tostring(f and f().hi()))\n`,
      "utf-8",
    );
    fs.writeFileSync(path.join(WORKSPACE_DIR, ".vscode", "settings.json"), JSON.stringify({ "nodemcu-vscode.pythonPath": "python3" }), "utf-8");

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
    await sleep(3000); // let the extension activate + set the host-compiler context
  }, 120_000);

  afterAll(() => {
    try { client?.close(); } catch { /* ignore */ }
    if (codeProcess?.pid) {
      if (process.platform === "win32") child_process.spawnSync("taskkill", ["/pid", String(codeProcess.pid), "/f", "/t"]);
      else codeProcess.kill();
    }
    killEdhByMarker(`nodemcu-vscode-lfscdp-ud-${RUN_ID}`);
  });

  async function pressKey(vk: number, key: string, code: string): Promise<void> {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: vk, key, code });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, key, code });
  }

  /** Open the command palette and set its filter; retries F1 until the box appears. */
  async function openPaletteWith(value: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      await pressKey(0x1b, "Escape", "Escape");
      await sleep(150);
      await pressKey(0x70, "F1", "F1");
      // Wait for the quick-input box to actually exist before touching it.
      let present = false;
      for (let i = 0; i < 12; i++) {
        present = await client.evaluate(`(() => !!document.querySelector(".quick-input-box input"))()`);
        if (present) break;
        await sleep(200);
      }
      if (!present) continue;
      const set = await client.evaluate(
        `(() => { const i = document.querySelector(".quick-input-box input"); if (!i) return false; i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
      );
      if (set) return;
    }
    throw new Error("command palette did not open");
  }

  /** Open the palette, filter to query, and return the listed rows (does not run). */
  async function paletteRows(query: string): Promise<string[]> {
    await openPaletteWith(query);
    await sleep(1200);
    const rows: string[] = await client.evaluate(
      `(() => Array.from(document.querySelectorAll(".quick-input-list .monaco-list-row")).map(r => (r.textContent||"").trim().replace(/\\s+/g," ")))()`,
    );
    await pressKey(0x1b, "Escape", "Escape");
    return rows;
  }

  async function runPaletteCommand(label: string): Promise<void> {
    await openPaletteWith(`>${label}`);
    for (let i = 0; i < 40; i++) {
      const ready = await client.evaluate(
        `(() => Array.from(document.querySelectorAll(".quick-input-list .monaco-list-row")).some(e => (e.textContent || "").includes(${JSON.stringify(label)})))()`,
      );
      if (ready) break;
      await sleep(250);
    }
    await pressKey(0x0d, "Enter", "Enter");
    for (let i = 0; i < 20; i++) {
      const open = await client.evaluate(`(() => !!document.querySelector(".quick-input-box input"))()`);
      if (!open) break;
      await sleep(200);
    }
  }

  async function getToasts(): Promise<string> {
    return await client.evaluate(
      `(() => Array.from(document.querySelectorAll(".notification-list-item-message")).map(t => (t.textContent||"").trim().replace(/\\s+/g," ")).join(" || "))()`,
    );
  }

  function readIni(): string {
    return fs.existsSync(iniPath) ? fs.readFileSync(iniPath, "utf-8") : "";
  }

  it("1. LFS commands are gated on a host C compiler (hasHostCompiler context)", async () => {
    const rows = await paletteRows(">NodeMCU");
    expect(rows.length, "NodeMCU commands should be listed").toBeGreaterThan(0);
    expect(rows.some((r) => /Enable LFS/i.test(r)), `Enable LFS should be available. Rows: ${rows.join(", ")}`).toBe(true);
    expect(rows.some((r) => /Build & Deploy LFS Image/i.test(r))).toBe(true);
    expect(rows.some((r) => /Disable LFS/i.test(r))).toBe(true);
  }, 60_000);

  it("2. Enable LFS builds, flashes, deploys, and the module runs from flash", async () => {
    await runPaletteCommand("NodeMCU: Enable LFS");

    // The command writes lfs_size immediately, then runs the long deploy.
    for (let i = 0; i < 20 && !/lfs_size\s*=\s*0x/i.test(readIni()); i++) await sleep(500);
    expect(readIni(), "Enable LFS should write a nonzero lfs_size").toMatch(/lfs_size\s*=\s*0x[1-9a-f]/i);

    // Wait for the deploy (build + flash + image + flashreload) to report success.
    const deadline = Date.now() + 900_000;
    let toasts = "";
    while (Date.now() < deadline) {
      toasts = await getToasts();
      if (/LFS image deployed/i.test(toasts)) break;
      if (/FAILED|failed to|image build failed|flashreload failed/i.test(toasts)) {
        throw new Error(`LFS deploy failed. Toasts: ${toasts}`);
      }
      await sleep(5000);
    }
    expect(/LFS image deployed/i.test(toasts), `expected LFS deploy success toast. Last toasts: ${toasts}`).toBe(true);

    // Verify on the device: release the extension's serial session, then read.
    await runPaletteCommand("NodeMCU: Release Serial Port");
    for (let i = 0; i < 10 && !(await canOpenSerialPort()); i++) await sleep(750);
    try {
      const { found, lines } = await readDeviceSerial("VPING", 15_000);
      expect(found, `device should report the LFS probe. Lines: ${lines.slice(-8).join(" / ")}`).toBe(true);
      const text = lines.join("\n");
      expect(text, "module should be a function in the flash index").toMatch(/VCHK inflash=function/);
      expect(text, "module should run from flash").toMatch(/VPING=lfs-cdp-ok/);
      expect(text, "module should be listed by node.LFS.list()").toMatch(new RegExp(`VMOD=${MODULE}`));
      // LFS-aware sync: the module must NOT also linger in SPIFFS (else require
      // would resolve the filesystem copy and bypass LFS).
      expect(text, "module should not be duplicated in SPIFFS").toMatch(/VSPIFFS=false/);
    } finally {
      await runPaletteCommand("NodeMCU: Reconnect Serial Port");
    }
  }, 960_000);
});
