/**
 * Hardware e2e: proves the documented TLS behaviour of `[build] ssl_buffer_size`.
 *
 * docs/modules/tls.md states the TLS module needs `CLIENT_SSL_ENABLE` and a
 * sufficiently large `SSL_BUFFER_SIZE` — the shipped 4096 is too small for most
 * real HTTPS servers, and 16384 (a full TLS record) is the recommended value.
 * This suite builds + flashes the firmware once per configured buffer size with
 * the `tls` module enabled, then runs the two upstream scratch HTTPS scripts on
 * the device:
 *   - `tests/scratch_https.lua`  → `http.get`         (GET_ENDPOINTS)
 *   - `tests/scratch_https3.lua` → `http.get_stream`  (STREAM_ENDPOINTS)
 * and asserts that a too-small buffer fails every TLS handshake while 16384
 * succeeds — i.e. the buffer size really governs TLS capability, as documented.
 *
 * This is real hardware + real internet, so it only runs when
 * NODEMCU_VSCODE_E2E_HARDWARE=1 and a Wi-Fi SSID is supplied via env; otherwise
 * it is skipped (keeps `npm test` clean). No credentials are hardcoded.
 *
 * Required env:
 *   NODEMCU_VSCODE_E2E_HARDWARE=1
 *   NODEMCU_VSCODE_E2E_WIFI_SSID=<ssid>
 * Optional env:
 *   NODEMCU_VSCODE_E2E_WIFI_PASS    (default "" — open network)
 *   NODEMCU_VSCODE_E2E_SERIAL_PORT  (default /dev/ttyUSB0 or COM7)
 *   NODEMCU_VSCODE_E2E_SERIAL_BAUD  (default 115200)
 *   NODEMCU_VSCODE_E2E_SSL_SIZES    (comma list, default "1024,16384")
 *   NODEMCU_VSCODE_E2E_PYTHON       (default "python")
 *   NODEMCU_VSCODE_STORAGE_ROOT     (managed-firmware cache root)
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SerialPort } from "serialport";
import { parseIni, defaultConfig, type NodemcuConfig } from "../../src/config/nodemcuIni";
import { BuildManager, type BuildContext } from "../../src/build/buildManager";
import { FlashManager } from "../../src/flash/flashManager";
import { ToolchainLocator } from "../../src/build/toolchain";
import { ensureManagedFirmware } from "../../src/firmware/managedFirmware";
import { Shell } from "../../src/util/shell";
import { DirectSerialUploader } from "../../src/upload/directSerialUploader";
import { defaultBuildDir, binOutput } from "../../src/util/paths";

const PORT = process.env.NODEMCU_VSCODE_E2E_SERIAL_PORT || (process.platform === "win32" ? "COM7" : "/dev/ttyUSB0");
const BAUD = Number(process.env.NODEMCU_VSCODE_E2E_SERIAL_BAUD || "115200");
const PYTHON = process.env.NODEMCU_VSCODE_E2E_PYTHON || "python";
// Wi-Fi must be supplied via env — never hardcode credentials in the repo.
const WIFI_SSID = process.env.NODEMCU_VSCODE_E2E_WIFI_SSID || "";
const WIFI_PASS = process.env.NODEMCU_VSCODE_E2E_WIFI_PASS ?? "";
const SIZES = (process.env.NODEMCU_VSCODE_E2E_SSL_SIZES || "1024,4096,8192,16384")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const STORAGE_ROOT = process.env.NODEMCU_VSCODE_STORAGE_ROOT || path.join(os.homedir(), ".nodemcu-vscode");

// Per-endpoint device-side watchdog. A real TLS handshake + download on the
// ESP8266 (80 MHz, software mbedtls) can take 20s+ for the first request after
// boot, so this must be generous enough that a *valid* slow endpoint isn't
// falsely cut to a -2 timeout — that was the flakiness. The host read timeout is
// derived from it so the reader never gives up before the device can finish.
const WATCHDOG_MS = 35_000;
// Fallback timeout (seconds): the device waits for an event-driven wifi.eventmon
// STA_GOT_IP rather than polling, but if Wi-Fi never associates this bounds the
// run with TLS_NOWIFI instead of hanging. Kept generous to cover a cold join right
// after a flash (SPIFFS format + association). (Empty first-runs turned out to be
// a dropped node.restart, handled in uploadAndRun, not the join wait.)
const WIFI_JOIN_SECONDS = 120;
// Host-side allowance for that join window before the endpoint loop starts; kept a
// touch above WIFI_JOIN_SECONDS so the reader never gives up before the device does.
const WIFI_CONNECT_MS = (WIFI_JOIN_SECONDS + 10) * 1000;
const readTimeoutFor = (endpointCount: number) => endpointCount * (WATCHDOG_MS + 4_000) + WIFI_CONNECT_MS;

// Endpoints lifted verbatim from the upstream scratch scripts.
const GET_ENDPOINTS = [
  "https://httpbin.org/ip",
  "https://google.com/",
  "https://www.howsmyssl.com/a/check",
  "https://api.ipify.org/",
  "https://postman-echo.com/get",
  "https://example.com/",
];
const STREAM_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://api.github.com/",
  "https://tls-v1-2.badssl.com:1012/",
];

const enabled = process.env.NODEMCU_VSCODE_E2E_HARDWARE === "1" && WIFI_SSID.length > 0 && SIZES.length >= 2;
const describe_ = enabled ? describe : describe.skip;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface HttpsResult {
  url: string;
  code: number;
  len: number;
  /** Free heap (node.heap()) before the request, after a double GC. */
  heapBefore: number;
  /** Lowest free heap sampled inside the request callbacks (the trough). */
  heapTrough: number;
}

interface RunOutcome {
  ip: string | null;
  results: HttpsResult[];
  lines: string[];
}

/** Lua quote a string for embedding in the generated init.lua. */
function luaQuote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Generate an init.lua mirroring the upstream scratch_https*.lua scripts: connect
 * to Wi-Fi, then walk the endpoint list with `http.get` / `http.get_stream`. It
 * brackets its output with a per-run nonce so the reader ignores stale output
 * from a previous run, and formats numbers with string.format (tostring(number)
 * is unreliable on some NodeMCU builds — see device REPL quirks).
 */
function buildScript(nonce: string, endpoints: string[], stream: boolean): string {
  const eps = endpoints.map(luaQuote).join(", ");
  // Each endpoint runs under a WATCHDOG_MS watchdog: if the callback never fires
  // (e.g. an unreachable host), it reports code -2 and advances, so one dead
  // endpoint can't stall the whole run. The window is generous so a valid but slow
  // TLS handshake completes rather than being falsely timed out. `done` is guarded
  // so the watchdog and the real callback can't both advance. Numbers use
  // string.format (tostring(number) is unreliable on some NodeMCU builds).
  // heaptrough tracks the lowest node.heap() seen while the request is in flight.
  // For the stream path it is sampled on every chunk callback (the steady-state
  // connection footprint, the docs' "tightest point of a single http.get_stream
  // request"); for the buffered get path it is sampled once in the final callback
  // (whole body still in RAM). It is reported alongside the result so the run can
  // be checked against the heap table in docs/modules/tls.md.
  //
  // NB: deliberately NO synthetic "low heap" filler here. The TLS handshake alone
  // needs 25-30 KB of heap (see docs/modules/tls.md); pre-allocating a filler to
  // squeeze heap pushes the handshake into OOM and the device reboot-loops before
  // a single chunk arrives, so the trough can never be sampled. Measuring a *bare*
  // get_stream is also exactly what the docs heap table reports, so this run is
  // directly comparable to it.
  const request = stream
    ? [
        `  local total = 0`,
        `  http.get_stream(url, nil, function(code, chunk, _h, fin)`,
        `    local h = node.heap() if h < heaptrough then heaptrough = h end`,
        `    if chunk then total = total + #chunk end`,
        `    if fin then done(code, total) end`,
        `  end)`,
      ]
    : [
        `  http.get(url, nil, function(code, data)`,
        `    local h = node.heap() if h < heaptrough then heaptrough = h end`,
        `    done(code, data and #data or 0)`,
        `  end)`,
      ];
  return [
    `print("TLS_RUN ${nonce}")`,
    `wifi.setmode(wifi.STATION)`,
    `wifi.sta.config({ ssid = ${luaQuote(WIFI_SSID)}, pwd = ${luaQuote(WIFI_PASS)}, auto = true })`,
    `local eps = { ${eps} }`,
    `local function go(i)`,
    `  if i > #eps then print("TLS_DONE ${nonce}") return end`,
    `  local url = eps[i]`,
    `  collectgarbage() collectgarbage()`,
    `  local heapbefore = node.heap()`,
    `  local heaptrough = heapbefore`,
    `  local advanced = false`,
    `  local wd = tmr.create()`,
    `  local function done(code, n)`,
    `    if advanced then return end`,
    `    advanced = true`,
    `    wd:unregister()`,
    `    print("TLS_RESULT " .. url .. " " .. string.format("%d", code) .. " " .. string.format("%d", n)`,
    `      .. " " .. string.format("%d", heapbefore) .. " " .. string.format("%d", heaptrough))`,
    `    go(i + 1)`,
    `  end`,
    `  wd:alarm(${WATCHDOG_MS}, tmr.ALARM_SINGLE, function() done(-2, 0) end)`,
    ...request,
    `end`,
    // Event-driven Wi-Fi join: fire the endpoint loop the instant the device gets
    // an IP via wifi.eventmon STA_GOT_IP, instead of polling getip() on a timer.
    // T.IP is already a string so it prints cleanly (no tostring() quirk). A single
    // fallback timer still emits TLS_NOWIFI if no IP ever arrives, and getip() is
    // checked once up front in case the station associated (auto=true) before this
    // script registered the handler and the event was already delivered. `joined`
    // guards against the up-front check and the event both firing go(1).
    `local joined = false`,
    `local function start(ip)`,
    `  if joined then return end`,
    `  joined = true`,
    `  print("TLS_IP " .. ip)`,
    `  go(1)`,
    `end`,
    `local wt = tmr.create()`,
    `wt:alarm(${WIFI_JOIN_SECONDS * 1000}, tmr.ALARM_SINGLE, function()`,
    `  if joined then return end`,
    `  joined = true`,
    `  print("TLS_NOWIFI")`,
    `  print("TLS_DONE ${nonce}")`,
    `end)`,
    `wifi.eventmon.register(wifi.eventmon.STA_GOT_IP, function(T)`,
    `  wt:unregister()`,
    `  start(T.IP)`,
    `end)`,
    `local cur = wifi.sta.getip()`,
    `if cur then wt:unregister() start(cur) end`,
  ].join("\n") + "\n";
}

/** Clone the base config and force-enable tls (+deps) with the given buffer size. */
function configForSize(base: NodemcuConfig, sslBufferSize: number): NodemcuConfig {
  const cfg: NodemcuConfig = JSON.parse(JSON.stringify(base));
  cfg.nodemcu.port = PORT;
  for (const m of ["wifi", "net", "node", "tmr", "uart", "file", "gpio", "http", "tls"]) {
    cfg.c_modules[m] = true;
  }
  cfg.build.ssl_buffer_size = sslBufferSize;
  return cfg;
}

const tool = new DirectSerialUploader();
const uploaderOpts = { python: PYTHON, port: PORT, baud: BAUD, baudUpload: BAUD, compile: false };

/**
 * Upload the script as init.lua, reset the device, and read its serial output
 * until the run finishes (or timeout). Parses TLS_RESULT/TLS_IP lines. Completion
 * is whichever comes first: the TLS_DONE nonce, a result for every endpoint, or a
 * detected crash-loop (the same URL reported 3+ times — the device reboots and
 * re-runs init.lua, e.g. an OOM from a huge buffer on a low-heap device).
 * The read timeout is derived from the endpoint count so a slow-but-valid TLS
 * handshake under the device watchdog is never cut short by the host.
 */
async function uploadAndRun(script: string, nonce: string, endpointCount: number): Promise<RunOutcome> {
  const timeoutMs = readTimeoutFor(endpointCount);
  const tmpFile = path.join(os.tmpdir(), `nodemcu-tls-e2e-${nonce}.lua`);
  fs.writeFileSync(tmpFile, script, "utf-8");
  // A just-flashed device formats its SPIFFS on first boot and won't answer the
  // REPL until that finishes, so the prompt-connect can time out — retry a few
  // times before giving up.
  let lastErr = "";
  let uploaded = false;
  for (let attempt = 0; attempt < 5 && !uploaded; attempt++) {
    if (attempt > 0) await sleep(5000);
    const up = await tool.upload(uploaderOpts, tmpFile, "init.lua", () => {});
    uploaded = up.success;
    lastErr = up.error ?? lastErr;
  }
  fs.rmSync(tmpFile, { force: true });
  if (!uploaded) throw new Error(`upload init.lua failed after retries: ${lastErr}`);

  const lines: string[] = [];
  const results: HttpsResult[] = [];
  let ip: string | null = null;
  let started = false;
  let done = false;
  let buffer = "";

  const sp = await new Promise<SerialPort>((resolve, reject) => {
    const p = new SerialPort({ path: PORT, baudRate: BAUD }, (err) => (err ? reject(err) : resolve(p)));
  });
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("latin1");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "").trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("TLS_")) continue;
      if (line === `TLS_RUN ${nonce}`) {
        started = true;
        continue;
      }
      if (!started) continue; // ignore stale output from a previous run
      lines.push(line);
      const ipm = /^TLS_IP\s+(\S+)/.exec(line);
      if (ipm) ip = ipm[1];
      const m = /^TLS_RESULT\s+(\S+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/.exec(line);
      if (m) {
        results.push({ url: m[1], code: Number(m[2]), len: Number(m[3]), heapBefore: Number(m[4]), heapTrough: Number(m[5]) });
        // Stop once every endpoint has reported, or when the device is clearly
        // crash-looping on one URL (re-running init.lua from the top each reboot).
        const distinct = new Set(results.map((r) => r.url));
        const repeats = results.filter((r) => r.url === m[1]).length;
        if (distinct.size >= endpointCount || repeats >= 3) done = true;
      }
      if (line === `TLS_DONE ${nonce}` || line === "TLS_NOWIFI") done = true;
    }
  };
  sp.on("data", onData);
  const restart = () =>
    new Promise<void>((resolve) => sp.write("\r\nnode.restart()\r\n", () => sp.drain(() => resolve())));
  await restart();

  // The first run right after a flash sometimes never emits its TLS_RUN marker:
  // the device is still settling (SPIFFS format / boot) when node.restart() is
  // written, so the command is dropped and init.lua never re-runs — the reader
  // would then just spin out the full timeout with zero results. Re-issue
  // node.restart() every 8s until the marker appears (capped) so a single dropped
  // restart can't silently cost a whole run.
  const deadline = Date.now() + timeoutMs;
  let nextKick = Date.now() + 8000;
  while (!done && Date.now() < deadline) {
    if (!started && Date.now() >= nextKick) {
      await restart();
      nextKick = Date.now() + 8000;
    }
    await sleep(300);
  }
  await new Promise<void>((resolve) => (sp.isOpen ? sp.close(() => resolve()) : resolve()));
  await sleep(process.platform === "win32" ? 1000 : 250);
  // Always surface a short trace so an empty/odd run is explainable from the log
  // (TLS_NOWIFI vs never-started vs partial) without re-running on hardware.
  process.stdout.write(
    `[tls run ${nonce}] started=${started} results=${results.length} ip=${ip} lines=${lines.slice(-6).join(" | ") || "(none)"}\n`,
  );
  return { ip, results, lines };
}

/** A successful HTTPS request (TLS handshake completed → a real HTTP status). */
function successes(results: HttpsResult[]): HttpsResult[] {
  return results.filter((r) => r.code >= 200 && r.code < 600);
}

describe_("TLS ssl_buffer_size (CDP-free hardware e2e)", () => {
  let firmwarePath = "";
  let generator: BuildContext["generator"];
  let baseConfig: NodemcuConfig;
  const shell = new Shell();
  // Per-size outcome: combined http.get + http.get_stream results.
  const bySize = new Map<number, { ip: string | null; results: HttpsResult[]; lines: string[] }>();
  let firstBuild = true;

  beforeAll(async () => {
    firmwarePath = await ensureManagedFirmware({ storageRoot: STORAGE_ROOT, onProgress: (m) => console.log(m) });
    const toolchain = await new ToolchainLocator(shell).locate();
    generator = toolchain.generator;
    try {
      baseConfig = parseIni(fs.readFileSync(path.join(process.cwd(), "nodemcu.ini"), "utf-8"));
    } catch {
      baseConfig = defaultConfig();
    }
  }, 600_000);

  async function buildAndFlash(cfg: NodemcuConfig): Promise<void> {
    if (firstBuild) {
      // Guarantee tls/http are actually compiled in (drop any stale cache/binaries).
      for (const target of [defaultBuildDir(firmwarePath), path.join(binOutput(firmwarePath), "0x00000.bin"), path.join(binOutput(firmwarePath), "0x10000.bin")]) {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      }
      firstBuild = false;
    }
    const build = await new BuildManager(shell).build({
      firmwarePath,
      config: cfg,
      parallel: true,
      jobCount: Math.min(os.cpus().length, 8),
      verbose: false,
      generator,
      onLog: (s) => process.stdout.write(s),
      onStderr: (s) => process.stderr.write(s),
    });
    expect(build.success, `firmware build (ssl_buffer_size=${cfg.build.ssl_buffer_size}): ${build.summary}`).toBe(true);

    const flash = await new FlashManager(shell).flash({
      python: PYTHON,
      firmwarePath,
      config: cfg,
      port: PORT,
      onLog: (s) => process.stdout.write(s),
      onStderr: (s) => process.stderr.write(s),
    });
    expect(flash.success, `flash (ssl_buffer_size=${cfg.build.ssl_buffer_size}) exit=${flash.exitCode}`).toBe(true);
    await sleep(10_000); // first boot after flash formats SPIFFS before the REPL answers
  }

  for (const size of SIZES) {
    it(`ssl_buffer_size=${size}: builds, flashes, and runs both HTTPS scripts`, async () => {
      const cfg = configForSize(baseConfig, size);
      await buildAndFlash(cfg);

      const getRun = await uploadAndRun(buildScript(`get${size}`, GET_ENDPOINTS, false), `get${size}`, GET_ENDPOINTS.length);
      // process.stdout.write (not console.log) so the evidence shows even on pass.
      process.stdout.write(`[tls ${size}] http.get IP=${getRun.ip} results=${JSON.stringify(getRun.results)}\n`);
      const streamRun = await uploadAndRun(buildScript(`str${size}`, STREAM_ENDPOINTS, true), `str${size}`, STREAM_ENDPOINTS.length);
      process.stdout.write(`[tls ${size}] http.get_stream IP=${streamRun.ip} results=${JSON.stringify(streamRun.results)}\n`);

      const results = [...getRun.results, ...streamRun.results];
      // The HTTPS loop only runs after the device gets an IP (wifi.eventmon
      // STA_GOT_IP), so any TLS_RESULT at all proves it joined Wi-Fi and tried TLS — this
      // distinguishes a real TLS failure (codes present, all negative) from no
      // network (TLS_NOWIFI, zero results).
      expect(
        results.length,
        `device must join Wi-Fi and attempt TLS (size ${size}). get lines: ${getRun.lines.slice(-8).join(" / ")}`,
      ).toBeGreaterThan(0);

      bySize.set(size, { ip: getRun.ip || streamRun.ip, results, lines: [...getRun.lines, ...streamRun.lines] });
    }, 1_800_000);
  }

  it("follows docs: a too-small buffer breaks TLS while 16384 succeeds", () => {
    const small = SIZES[0];
    const big = SIZES[SIZES.length - 1];
    const smallOut = bySize.get(small);
    const bigOut = bySize.get(big);
    expect(smallOut, `missing results for size ${small}`).toBeDefined();
    expect(bigOut, `missing results for size ${big}`).toBeDefined();

    // Heap table for eyeballing against docs/modules/tls.md: for each buffer size,
    // how many endpoints completed TLS and the lowest heap trough seen among the
    // successful streaming requests (the docs' "free heap at trough" column).
    process.stdout.write(`\n[tls] ===== heap / success summary (compare to docs/modules/tls.md) =====\n`);
    process.stdout.write(`[tls] ${"size".padStart(6)}  ${"ok/total".padStart(8)}  ${"min trough (KB)".padStart(15)}  worked\n`);
    for (const size of SIZES) {
      const out = bySize.get(size);
      if (!out) continue;
      const ok = successes(out.results);
      const troughs = ok.map((r) => r.heapTrough).filter((h) => h > 0);
      const minTroughKb = troughs.length ? (Math.min(...troughs) / 1024).toFixed(1) : "n/a";
      const worked = ok.map((r) => `${r.url}(${(r.heapTrough / 1024).toFixed(1)}KB)`).join(" ");
      process.stdout.write(
        `[tls] ${String(size).padStart(6)}  ${`${ok.length}/${out.results.length}`.padStart(8)}  ${String(minTroughKb).padStart(15)}  ${worked}\n`,
      );
    }
    process.stdout.write(`[tls] =====================================================================\n\n`);

    const smallOk = successes(smallOut!.results);
    const bigOk = successes(bigOut!.results);
    process.stdout.write(`[tls] success counts: ${small}=${smallOk.length}/${smallOut!.results.length}, ${big}=${bigOk.length}/${bigOut!.results.length}\n`);

    // Recommended buffer completes real TLS handshakes.
    expect(bigOk.length, `ssl_buffer_size=${big} should complete TLS for at least one endpoint`).toBeGreaterThan(0);
    // Too-small buffer cannot complete any TLS handshake (the documented failure).
    expect(smallOk.length, `ssl_buffer_size=${small} should fail every TLS handshake (codes: ${smallOut!.results.map((r) => r.code).join(",")})`).toBe(0);
    // And, monotonically, the larger buffer enables strictly more than the small one.
    expect(bigOk.length).toBeGreaterThan(smallOk.length);
  });
});
