# NodeMCU e2e flow — verified CDP + serial recipe

Captured by driving a real Extension Development Host (`code.cmd`,
`--remote-debugging-port=9222`) against a **real ESP8266 on COM7 @ 115200**
(NodeMCU 3.0.0.0, float build, Lua 5.1.4). Everything below was confirmed
interactively before any Vitest e2e was written (AGENTS.md §9.8 rule).

## Launch + connect

- Build first (`npm run build`), then launch `code.cmd` with
  `--new-window --disable-workspace-trust --user-data-dir=<iso> --extensions-dir=<iso>
  --extensionDevelopmentPath=<repo> --remote-debugging-port=9222 <workspace>`.
- Seed `<iso user-data>\Local State` + `User\globalStorage\state.vscdb`
  (+ `storage.json`) from `$env:APPDATA\Code` to skip the AI splash.
- Discover the renderer: `GET http://127.0.0.1:9222/json`, pick the target whose
  `title` includes `[Extension Development Host]` and `type === 'page'`, open its
  `webSocketDebuggerUrl`, call `Runtime.enable`.

## Verified DOM selectors

| Thing | Selector |
| --- | --- |
| NodeMCU activity-bar item | `.activitybar .action-item` whose `aria-label` matches `/NodeMCU/i`. Item is "open" when it / its `a.action-label` has class `checked`. **Clicking an already-open item closes the sidebar** — check `checked` before clicking (the bundled `focus-sidebar` heuristic can toggle it shut). |
| View panes | `.sidebar .pane`; identify by `.pane-header` **`aria-label`**: `Device Explorer Section`, `Lua Modules Section`, `C Modules Section` (do NOT rely on `.title-label`). |
| Pane expanded state | `.pane-header` `aria-expanded` = `"true"`/`"false"`; click header to toggle. |
| List rows | `.monaco-list-row` inside a pane (virtualized — only visible rows exist in DOM; scroll to reach others). |
| Module checkbox | `row.querySelector('.monaco-checkbox')`; **checked** ⇔ `cb.classList.contains('checked')` and `cb.getAttribute('aria-checked')==='true'`. Click `cb` to toggle. |
| Row text format | C module row = `"<name><category>[ ✓ enabled]"` e.g. `adccore ✓ enabled`, `coapcore`. Lua module row = `"<name><description>"` e.g. `fifoA generic fifo module. ...`. Match a module by `row.textContent.trim().startsWith("<name>")` (watch prefix collisions, e.g. `file` vs `file_lfs`). |
| Device Explorer rows | `"<COM><manufacturer>[ selected]"` e.g. `COM7Silicon Labs selected`. |
| Status bar | `.statusbar-item` (textContent). |
| Notification toast text | `.notifications-toasts .notification-list-item-message` (or `.notification-toast`). |
| Notification button (Proceed/Cancel) | `.monaco-button` whose trimmed text matches (e.g. `Proceed`). |

## Key input recipes (CDP `Input.dispatchKeyEvent`, modifiers: Ctrl=2, Shift=8)

- Command palette: Escape → F1 (vk 0x70) → set `.quick-input-box input` value to
  `>` + title, dispatch `input` event → Enter (vk 0x0D).
- Quick open a file: Ctrl+P (vk 0x50, mods 2) → set input value to filename →
  Enter. Active tab = `.tab.active` (`aria-label`/textContent).
- Edit active Monaco editor: focus `.monaco-editor textarea.inputarea` →
  Ctrl+A (vk 0x41, mods 2) → `Input.insertText {text}` → Ctrl+S (vk 0x53, mods 2).
  **Ctrl+S on a non-dirty doc is a no-op** (no `onDidSaveTextDocument`); always
  change the text first.

## The flows (command IDs + observed behavior)

1. **Initialize** — `NodeMCU: Initialize Project` creates `nodemcu.ini`,
   `src/`, `src/init.lua`; flips `nodemcu.projectValid`; auto-detects and writes
   `port=COM7`; default `[c_modules]` = `file adc bit dht gpio i2c mqtt net node
   ow pwm spi tmr uart wifi` — **identical to this device's firmware modules**,
   which is why no rebuild happens on first sync.
2. **Toggle module** — clicking a C/Lua checkbox writes `nodemcu.ini` only
   (`[c_modules] <name>=true|false`, `[lua_modules] <name>=lua_modules/<name>/<file>.lua`)
   and refreshes the tree. It does **not** touch the device. (Pre-fix behavior;
   see fix #4 — Lua modules now ride along with the save-upload.)
3. **First save / full sync** — `onDidSaveTextDocument` under `src/` →
   `scheduleSrcSync` (300 ms debounce) → with empty `[sync] last_timestamp`,
   `mirrorSrcToDevice` runs:
   - First time on a fresh workspace the device is unclaimed → a blocking
     **Proceed/Cancel** warning toast appears ~4-5 s in (after the serial
     identity read): *"Device 48:3f:da:a4:40:b8 is not listed in nodemcu.ini …
     Proceeding will add it, format the device filesystem, and sync files from
     src/."* The op stays gated on `idle` until clicked; **poll for the
     `Proceed` `.monaco-button` and click it** (it aborts if left unanswered).
   - Then status bar shows `formatting COM7...` (**~36 s** full FS format) →
     `syncing N upload(s), M delete(s)...` → `synced N operation(s)`.
   - On success: `[devices] uuids=483fdaa440b8`, `[sync] last_timestamp=<iso>`
     written; device hard-reset; `init.lua` runs.
4. **Subsequent save** — with `last_timestamp` set, `doUploadSingleFile` uploads
   just the saved file (fast, no format, no prompt).
5. **Lua module sync (pre-fix manual path)** — `NodeMCU: Sync Lua Modules to
   Device` compiles + uploads each enabled local module as `<name>.lc`
   (`uploading fifo...` → `synced 1 module(s)`, ~9 s).

## Serial verification (the only reliable way to prove "it ran")

The integrated terminal is canvas-rendered — CDP can't read the byte stream.
Open COM7 directly with `pyserial` (or `serialport`) **after** the UI sync
completes and the extension has released the port:

- Reset to get the boot banner + `init.lua` output: `setDTR(False); setRTS(True);
  sleep(0.1); setRTS(False); setDTR(False)`. Banner self-reports
  `modules: adc;bit;dht;file;...` (handy for fix #1 device-state checks).
- Or query the live Lua prompt directly:
  `do local ok,m=pcall(require,'fifo'); print('FIFO_REQUIRE', ok, type(m)) end\r\n`
  → `FIFO_REQUIRE  true  table` once `fifo.lc` is on the device.
- Force UTF-8 stdout with `errors="replace"` — the boot ROM prints garbage bytes
  at a different baud that crash cp1252 consoles.

## Timing / gotchas for the Vitest e2e

- Full first sync ≈ 44 s (format ≈ 36 s). Use ≥ 90-120 s timeouts for sync
  tests; ≥ 15 s for Lua-module sync; short for toggles.
- Only one process may hold COM7 — close serial monitors / the extension's port
  before a direct `serialport` read, and vice-versa.
- A prompt left unanswered (or dismissed with Escape) leaves the OperationGate
  holding a stuck op; a clean `Developer: Reload Window` resets it.
- Device MAC `48:3f:da:a4:40:b8` → uuid `483fdaa440b8`.

## Gotchas learned while encoding `tests/e2e/device_cdp_e2e.test.ts`

- **Orphaned EDH hijacks the debug port.** `code.cmd` returns immediately after
  spawning the real `Code.exe`, so `taskkill /pid <code.cmd> /t` does NOT kill the
  EDH — it survives holding `--remote-debugging-port`, and the next run binds
  nothing and connects to the *stale* window (wrong/already-initialized
  workspace). Fix: kill `Code.exe` whose `CommandLine` matches a unique marker
  (the run's `--user-data-dir`), in both `beforeAll` (clear prior runs) and
  `afterAll`. See `killEdhByMarker` in the test.
- **Stale success toasts cause early returns.** After fix #3, results are
  notification toasts. Two consecutive single-file saves both end with the
  identical toast `NodeMCU: uploaded init.lua`, so a waiter keyed on that text
  returns on the *previous* op's lingering toast and the serial check runs before
  the new upload finishes. Fix: run `>Clear All Notifications` before each save,
  AND require seeing an active-phase toast (`uploading|syncing|removing|...`)
  before accepting a success toast.
- **Monaco edits need a real mouse-click focus.** `textarea.inputarea.focus()`
  alone did not reliably land Ctrl+A / `Input.insertText`; the save then uploads
  the *unchanged* default file (device prints the original `Hello World`).
  Fix: click the `.view-lines` surface via `Input.dispatchMouseEvent`, then
  Ctrl+A → `insertText`, and verify the editor (and the on-disk file) actually
  contain the new text before relying on the upload.
- **Auto port detect lands slightly after the ini is created** — poll for
  `port=COM7` rather than asserting immediately after init.
- **Verify on the device, not the UI.** Each scenario asserts by reopening COM7
  with `serialport`, sending `node.restart()`, and matching the printed marker
  line — the only proof the file/module actually reached and ran on hardware.
