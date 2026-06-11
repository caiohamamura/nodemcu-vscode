---
name: devtools-automation
description: Drive a running VS Code/Electron instance (e.g. the NodeMCU Extension Development Host) over Chrome DevTools Protocol — focus the sidebar, expand panes, inspect/toggle checkbox state, run command-palette commands, capture console logs, reload the window. Use this whenever you need to verify the NodeMCU UI in a real renderer without a human in the loop.
---

# DevTools Automation Skill

This skill allows an agent to connect to a running Extension Development Host or
any Electron-based editor window with remote debugging enabled (e.g. port `9222`)
and simulate user actions, query UI tree-view states, toggle checkboxes, or
execute command palette commands.

For the **production** version of this skill (used in CI), see
[`tests/e2e/cdp_e2e.test.ts`](../../../tests/e2e/cdp_e2e.test.ts) and
[`tests/e2e/device_cdp_e2e.test.ts`](../../../tests/e2e/device_cdp_e2e.test.ts).
The script bundled with this skill (`scripts/cdp-control.js`) is the lightweight
ad-hoc counterpart for live debugging.

## Prerequisites

- The Extension Development Host (or target IDE window) must be launched with
  the `--remote-debugging-port=9222` flag.
- Node.js 22+ so `fetch` and the global `WebSocket` are natively available.
- The default port is `9222` (override with the `PORT` env var).

## Launching a fresh Extension Development Host

```powershell
# Build first so dist/extension.js is current
npm run build

# On Windows — use code.cmd rather than Code.exe
$env:VSCODE_E2E_EXECUTABLE = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"

# Optional fakes so the host can run without real hardware
$env:NODEMCU_VSCODE_NODEMCU_TOOL   = "C:\path\to\fake-nodemcu-tool.js"
$env:NODEMCU_VSCODE_FAKE_SERIAL_PORTS = '[{"path":"COM42","manufacturer":"NodeMCU Test Board"}]'

# Launch a fresh EDH with isolated user-data + extensions dirs
$code = $env:VSCODE_E2E_EXECUTABLE
$args = @(
  "--new-window",
  "--disable-workspace-trust",
  "--user-data-dir=C:\temp\user-data",
  "--extensions-dir=C:\temp\extensions",
  "--extensionDevelopmentPath=$(Get-Location)",
  "--remote-debugging-port=9222",
  "C:\temp\workspace"
)
& $code @args
```

Wait ~5s, then verify the target is reachable:

```bash
curl http://127.0.0.1:9222/json | Out-String
```

The title of the relevant target should contain `[Extension Development Host]`.

## Avoiding the first-run AI splash

A brand-new `--user-data-dir` triggers a full first-run flow on every launch:
a "How do you want to use AI?" / "Use GitHub Copilot?" / "Sign in to set up chat"
dialog blocks the renderer until dismissed. CDP queries on the workbench
become flaky because the dialog can intercept the next click target.

The first-run state is per-user-data-dir, not per-install. A profile that has
already been "configured" (telemetry acknowledged, AI welcome accepted, etc.)
skips the splash entirely. Two ways to get that pre-configured state:

### Option A — reuse the current user's profile (quickest)

Pass the real user profile as `--user-data-dir`:

```powershell
# Windows: %APPDATA%\Code
--user-data-dir="$env:APPDATA\Code"
```

Caveats:
- The current user must not have a regular VS Code instance open against the
  same profile (single-instance lock on the user-data-dir).
- The session will read/write the user's real settings, keybindings, recent
  projects, etc. — so commands like `Developer: Reload Window` mutate the
  live profile. Acceptable for ad-hoc debugging, **not** for the e2e suite.

### Option B — seed the first-run flags into a fresh profile (isolated, recommended for e2e)

Copy the small set of state files that gate the first-run dialogs from a
known-good profile into the new `--user-data-dir` before launch. A safe
minimal set is:

| File (relative to user-data-dir) | Purpose |
| --- | --- |
| `Local State` | Top-level install + telemetry-ack flags (e.g. `telemetryNoticeAcknowledged`). |
| `User/globalStorage/state.vscdb` | Per-profile memento including the Copilot/chat setup markers (`chat.setupContext`, `config.chat.setupFromDialog`, `workbench.welcomePage.*`). |

Concretely (PowerShell):

```powershell
$seed = "$env:APPDATA\Code"                # any already-configured profile
$dst  = "C:\temp\user-data"                # the new profile for the EDH
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item -Path "$seed\Local State"                       -Destination "$dst\Local State"
Copy-Item -Path "$seed\User\globalStorage\state.vscdb"    -Destination "$dst\User\globalStorage\state.vscdb"
# extensions-dir stays in a temp dir so we don't drag the user's extensions in
```

The seeded `state.vscdb` will reference the seeded profile's id; if the new
profile needs a stable id, copy `User/globalStorage/storage.json` as well so
VS Code re-uses the same `__default__profile__` memento key.

> Verified 2026-06-06 against VS Code 1.x: launching with
> `--user-data-dir=$APPDATA\Code` produced `dialogs: []` and zero
> AI-splash keyword matches in the workbench DOM (`hasEditor: true`,
> chat panel showing the normal "Sign In" button, no modal).



## Repo Notes

- **Full verified NodeMCU e2e flow** (launch, selectors, init→toggle→save→sync,
  the device-claim `Proceed` prompt, timings, and the `pyserial` verification
  recipe) is captured in [`notes/nodemcu-e2e-flow.md`](notes/nodemcu-e2e-flow.md).
  Read it before writing or fixing `tests/e2e/*.test.ts`.
- For this repository, always prefer a fresh Extension Development Host started
  from the rebuilt workspace, with its own `--user-data-dir` and
  `--extensions-dir`, so CDP actions are not pointed at a stale renderer.
- Before adding or running a full Vitest e2e for a new UI path, first prove the
  path interactively against one running EDH with small CDP probes. Query the
  DOM, click one thing, inspect state, and only then encode the selectors into
  the test. This is much faster than discovering selector bugs through a
  multi-minute hardware suite.
- On Windows, launch VS Code through the `bin/code.cmd` CLI wrapper when
  possible; it is the more reliable path for extension-development-host sessions
  than calling `Code.exe` directly.
- Before tree-view assertions, open the NodeMCU activity bar item and expand
  the panes; the sidebar can exist before the extension has actually populated
  its data. Validate both **Device Explorer** (serial ports) and **Device Files**
  (remote files) after the split.
- In current VS Code builds, NodeMCU view pane titles are reliably exposed on
  `.pane-header` as `aria-label` values such as `Device Files Section`; do not
  depend on `.title-label` for pane identification. For Device Files rows, first
  find the `.pane` whose header `aria-label` contains `Device Files`, then search
  that pane's `.monaco-list-row` children.
- To focus the NodeMCU sidebar, find the visible activity-bar item whose
  `title` or `aria-label` contains `NodeMCU`, get its bounding rect, and click
  it with `Input.dispatchMouseEvent`; DOM `.click()` and quick-pick view opening
  can be flaky or can select adjacent results.
- `NodeMCU: Initialize Project` is the reliable activation point for
  workspace-scoped tests because it creates `nodemcu.ini`, seeds `init.lua`,
  and causes the views to refresh.
- When testing upload and device explorer flows without real hardware, the
  harness can inject `NODEMCU_VSCODE_NODEMCU_TOOL` and
  `NODEMCU_VSCODE_FAKE_SERIAL_PORTS` into the Extension Development Host
  process. See [AGENTS.md §7.4](../../../AGENTS.md#74-test-only-environment-variables)
  for the full env-var contract.
- Auto-port selection should be visible after activation when the fake serial
  ports contain exactly one NodeMCU-like entry, e.g.
  `[{"path":"COM42","manufacturer":"NodeMCU Test Board"}]`. Confirm the port
  appears selected in Device Explorer and is written to `nodemcu.ini` unless a
  valid configured port already exists.
- Device Files rows open live-edit documents. With the fake `nodemcu-tool`,
  seed `NODEMCU_VSCODE_FAKE_NODMCU_TOOL_STATE` with a file, click the row, edit
  the `nodemcu-live:` document, save, and verify the fake state file changes.
- When editing Monaco editors through CDP, use `Input.dispatchKeyEvent` with
  `type: "keyDown"` for modified keys such as Ctrl+A / Ctrl+S; `rawKeyDown`
  did not reliably select text in the active editor. A proven sequence is:
  click/focus the active editor, send Ctrl+A as `keyDown`/`keyUp`, call
  `Input.insertText`, then send Ctrl+S as `keyDown`/`keyUp`.
- For rapid live-save tests, do not issue the second edit immediately after the
  first Ctrl+S. Wait until the status bar shows `saving init.lua...`, then make
  the second edit and save. That proves interruption of an active upload without
  racing VS Code's document-save event plumbing.
- The Serial Console is a bottom-panel WebviewView (`nodemcu.serialConsole`),
  not an integrated terminal. In the workbench DOM, verify the `NodeMCU Serial`
  panel is selected and an `iframe.webview.ready` exists with
  `extensionId=caiohamamura.nodemcu-vscode`. The webview content itself is a
  nested frame under the webview target; inspect that frame when checking
  `#portLabel`, `#stateLabel`, `#output`, and `#input`.
- `NodeMCU: Upload and Monitor` is the F5 workflow: run it from the command
  palette or dispatch F5, then verify changed files upload, Lua modules sync,
  and the `NodeMCU Serial` panel remains focused. The command no longer opens a
  separate terminal process.
- If a renderer looks stale, verify the target in `http://127.0.0.1:<port>/json`
  is the current `Extension Development Host`, then prefer `reload-window` or
  a new host over reusing an old one.

## Command Index

Use the bundled script at [.claude/SKILLS/devtools-automation/scripts/cdp-control.js](file:///c:/Users/caioh/src/vscode/nodemcu-vscode/.claude/SKILLS/devtools-automation/scripts/cdp-control.js) to execute the following automation tasks:

### 1. Ensure Sidebar Is Visible
Focuses and expands the NodeMCU extension sidebar activity item.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js focus-sidebar
```

### 2. Expand All Collapsed Sidebar Panes
Expands any view sections (like C Modules, Lua Modules) that are currently collapsed.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js expand-panes
```

### 3. Inspect Current UI State
Retrieves lists of all visible items in the C Modules, Lua Modules, Device Explorer, and Device Files panes including checkbox status (`true`/`false`) when supported by the script.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js get-state
```

### 4. Toggle a Module Checkbox
Clicks the checkbox next to any C or Lua module to add or remove it from the configuration.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js toggle <module-name>
# Example: Toggle the "adc" module
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js toggle adc
```

### 5. Click or Double-Click a List Row
Performs click and double-click actions on a list row element containing specific text (e.g., to trigger task actions or ports).
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js click-row <row-text>
# Example: Click/Trigger the "Build Firmware" task row
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js click-row "Build Firmware"
```

### 6. Execute a Command Palette Command
Simulates pressing F1, typing a VS Code command, and pressing Enter to execute it.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js run-command "<command-text>"
# Example: Initialize the project configuration
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js run-command "NodeMCU: Initialize Project"
# Example: Run the F5 upload flow
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js run-command "NodeMCU: Upload and Monitor"
# Example: Show and connect the Serial Console directly
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js run-command "NodeMCU: Open Serial Console"
```

### 7. Reload the Window
Forces a reload of the extension host to test clean activation or reset state.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js reload-window
```

### 8. Stream Console Logs in Real-time
Enables DevTools runtime and system console logging. The command runs persistently and streams all IDE `console.log` statements, debugger output, and internal logs.
```bash
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js capture-console
```

## How It Works Under the Hood

The automation client communicates with Electron's Chrome instance using standard Chrome DevTools Protocol (CDP) messages sent over WebSockets:
1. It queries `http://127.0.0.1:9222/json` to discover the WebSocket URL of the renderer.
2. It connects to the target WebSocket and calls `Runtime.enable` to allow JS evaluation.
3. For mouse/interaction clicks, it queries elements in the DOM (`document.querySelector`) and fires native DOM events (e.g. `.click()` or `new Event('input')`).
4. For keyboard shortcuts, it dispatches synthetic key events using `Input.dispatchKeyEvent` with virtual key codes (e.g. `112` for `F1`, `13` for `Enter`, `27` for `Escape`).
