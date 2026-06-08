# NodeMCU VSCode TODO Handoff

Last updated: 2026-06-08.

## 2026-06-08 Update: Physical Device Live-Edit E2E

Manual CDP discovery was done before finalizing the automated test:

- Launched a single Extension Development Host on CDP port `9249` with a fresh temp workspace and physical `COM7`.
- Clicked the NodeMCU activity-bar item by CDP mouse coordinates, then located panes by `.pane-header[aria-label]`.
- Confirmed the reliable Device Files selector is the pane whose header `aria-label` contains `Device Files`; `.title-label` is unreliable/empty in this VS Code build.
- Clicked `init.lua` in Device Files and confirmed it opened a `nodemcu-live:` editor containing `print('HELLO_FROM_UPLOAD_CHANGES')`.
- Confirmed Monaco editor replacement needs CDP `Input.dispatchKeyEvent` with `type: "keyDown"` for Ctrl+A / Ctrl+S. `rawKeyDown` did not reliably select editor text.
- Performed the rapid two-save sequence manually:
  - replace with `print("Hello world")`, save
  - after ~100ms replace with `print("Hello world!")`, save
  - observed status progression: `Interrupting Save Live Device File...` → `saving init.lua...` → `saved init.lua`
- Confirmed the final device content by direct serial DTR/RTS reset; the boot output printed `Hello world!`.
- Confirmed VS Code's integrated Terminal / serial monitor is canvas-rendered: DOM text and CDP accessibility tree expose the terminal widget/title but not the serial bytes. For e2e assertions, use CDP for UI/editor/save behavior and direct `serialport` capture for final hardware output.
- The first automated version exposed a real bug: aborting `nodemcu-tool` mid live-save could leave/upload a zero-byte `init.lua` while reporting success. Final fix:
  - `onDidSaveTextDocument` snapshots `doc.getText()` synchronously before entering `OperationGate`.
  - `uploadLiveDocument()` now prefers `DirectSerialUploader` for live saves, falling back to `nodemcu-tool` only if direct serial fails. The direct path writes a temp file and renames it, avoiding zero-byte target files during interrupted saves.
- Rapid-save e2e now waits until the first save reaches `saving init.lua...` before making the second edit. This still interrupts an active upload but avoids racing VS Code's save-event dispatch.
- Final physical verification passed:
  - `npm run typecheck`
  - `npm run build`
  - `npm run test:unit` — 127 passed
  - `npm run test:integration` — 20 passed
  - `npm exec vitest run tests/e2e/device_cdp_e2e.test.ts` — 5 passed on `COM7`

Files changed in this update:

- `tests/e2e/device_cdp_e2e.test.ts`
  - Added physical test `7. Opens init.lua from Device Files and saves rapid live edits to the device`.
  - Added CDP helpers for NodeMCU sidebar focus, Device Files row click, live editor text replacement, live save polling, and DTR/RTS serial reset capture.
  - Made CDP debug port and firmware repo configurable via `NODEMCU_VSCODE_E2E_CDP_PORT` and `NODEMCU_VSCODE_E2E_FIRMWARE_REPO`.
- `src/extension.ts`
  - Await `deviceFilesProvider.reload()` before reporting upload/live-save success so tests and users do not see success while the provider is still holding the COM port.
  - `doRefreshExplorer()` now refreshes all providers, not only ports.
  - Live-edit saves snapshot document content before entering the operation gate and prefer direct serial upload for atomic save behavior.
- `.claude/SKILLS/devtools-automation/SKILL.md`
  - Added the learned CDP selectors and Monaco/terminal guidance.

## What Was Implemented And Verified

All three user-reported issues have been fully addressed:

### Issue 1: Cannot live edit `init.lua`
- **Root cause**: `nodemcu-tool download` fails for `init.lua` on some firmware versions (filesystem errors).
- **Fix**: `src/upload/directSerialUploader.ts` now has a `download()` method that reads file content over raw serial using Lua `uart.write` hex encoding.
- `doOpenLiveDeviceFile()` in `extension.ts` tries `NodemcuTool.downloadContent()` first, then falls back to `DirectSerialUploader.download()`.
- `uploadLiveDocument()` uses a temp file and `uploadWithFallback()` for the save path.
- Unit test: `tests/unit/directSerialUploader.test.ts` covers upload, compile, and reset.

### Issue 2: Commands feel opaque; logs should open automatically
- `showOperationLog(name)` in `extension.ts` calls `outputChannel.show(true)` and appends a timestamped header.
- `commandWithOperation(name, fn)` wraps commands through both `showOperationLog` and `operationGate.run`.
- `setStatus()` already appends timestamped lines for non-idle states.
- All serial/device commands are registered with `commandWithOperation()`.

### Issue 3: Spam-clicking / concurrent commands risk COM port deadlocks
- `src/util/operationGate.ts`: `OperationGate` class.
  - `run(name, task)` aborts any current active operation, calls `onInterrupt(previousName)`, waits up to 3s for previous to finish, then starts the new task with a fresh `AbortSignal`.
- The gate is initialized in `activate()` with `onInterrupt` that:
  - Appends "Interrupting: <name>" to the NodeMCU output channel.
  - Calls `setStatus("uploading", "Interrupting ...")`.
  - Calls `closeSerialMonitors()` to release the COM port.
- `AbortSignal` is threaded through `BuildManager`, `FlashManager`, `NodemcuTool`, and `DirectSerialUploader`.
- The `onDidSaveTextDocument` handler also uses the gate for live-edit saves.

## Verification Passed

- `npm run typecheck` — 0 errors
- `npm run build` — succeeds (212.6kb)
- `npm run test:unit` — 127 tests passed (16 files)
- `npm run test:integration` — 20 tests passed (3 files)
- `npm exec vitest run tests/e2e/cdp_e2e.test.ts` — 3 passed (fake serial, VS Code EDH, ~9s)
- `npm exec vitest run tests/e2e/device_cdp_e2e.test.ts` — 4 passed (real COM7 device, ~84s)
  - Test 1: Initialize Project → `nodemcu.ini` created ✓
  - Test 2: Toggle C module in sidebar → ini updated ✓
  - Test 5: Upload `init.lua`, verify `HELLO_FROM_CDP_E2E_TEST` prints on serial ✓
  - Test 6: Upload Changes while serial monitor open → monitor closed, upload succeeded, `HELLO_FROM_UPLOAD_CHANGES` prints ✓

## What Still Needs To Be Done

- Update README.md / AGENTS.md to document:
  - Log output auto-opens on serial/device commands.
  - Starting a new command interrupts the previous one (COM port safety).
  - `init.lua` live edit works via direct serial fallback.

## Files Changed In This Feature Set

- **`src/util/operationGate.ts`** [NEW]: `OperationGate` class with interrupt support.
- **`src/upload/directSerialUploader.ts`** [MODIFIED]: Added `download()` / `downloadAtBaud()` for reading files over raw serial.
- **`src/upload/nodemcuTool.ts`** [MODIFIED]: `NodemcuToolOptions.signal?: AbortSignal`; all `runWithDelay()` calls pass `opts.signal`.
- **`src/build/buildManager.ts`** [MODIFIED]: `BuildContext.signal?: AbortSignal`; shell calls pass `ctx.signal`.
- **`src/flash/flashManager.ts`** [MODIFIED]: `FlashContext.signal?: AbortSignal`; shell call passes `ctx.signal`.
- **`src/extension.ts`** [MODIFIED]: 
  - Imports `OperationGate`, `DirectSerialUploader`.
  - `operationGate` initialized in `activate()` before any commands.
  - `showOperationLog()` / `commandWithOperation()` helpers.
  - All serial/device commands registered with `commandWithOperation()`.
  - Live-edit save uses `operationGate.run()`.
  - `doOpenLiveDeviceFile()` has direct serial fallback.
  - `uploadLiveDocument()` uses temp file + `uploadWithFallback()`.
  - `doOpenSerialMonitor()` now accepts `_signal?` parameter.

## Tests Added/Updated

- **`tests/unit/operationGate.test.ts`** [NEW]: Tests interrupt behavior, signal propagation, three rapid runs (last wins), timeout guard, idle gate.
- **`tests/unit/liveEditFs.test.ts`** [NEW]: Tests `LiveEditFileSystemProvider` — setDocument/readFile round-trip, metadata, writeFile, delete, rename, URI encoding, onDidChangeFile events.
- **`tests/unit/liveEditSave.test.ts`** [NEW]: Integration of `OperationGate` + live-edit save wiring — second save interrupts first, AbortSignal is aborted when superseded, unrelated command interrupts save, three rapid saves only the last commits.
- **`tests/integration/managers.test.ts`** [UPDATED]: Added `uploadContent` test.

## Known Local Environment

- VS Code CLI: `C:\Users\caioh\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd`
- Physical device: `COM7`, baud `115200`, Silicon Labs CP210x.
- Firmware checkout: `C:\Users\caioh\src\nodemcu-firmware`
- esptool: `python -m esptool` version 5.3.0

## Misc Notes

- Vitest prints a `poolOptions` deprecation warning — it's noise, tests still pass.
- There is a `src/init.lua` from an old CDP test run. It's unrelated to the live-edit fix.
- The log file `build_debug.log` has debug `appendFileSync` calls in `doBuild()` — they can be cleaned up later but do not affect functionality.
- `tests/__mocks__/vscode.ts` is a minimal runtime vscode shim used by `liveEditFs.test.ts`. It is wired via `vitest.config.ts` `resolve.alias`. Only the APIs actually used by `liveEditFs.ts` are implemented.
