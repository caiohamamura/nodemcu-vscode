# NodeMCU VSCode TODO Handoff

Last updated: 2026-06-08.

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
- `npm run test:unit` — 101 tests passed (14 files)
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

- **`tests/unit/operationGate.test.ts`** [NEW]: Tests interrupt behavior.
- **`tests/unit/directSerialUploader.test.ts`** [NEW]: Tests upload, compile, and hard reset.
- **`tests/integration/managers.test.ts`** [UPDATED]: Added `uploadContent` test.
- **`tests/unit/packageManifest.test.ts`** [UPDATED]: Tests for new view/commands/keybindings.
- **`tests/unit/autoPort.test.ts`** [NEW]: Tests auto port selection logic.
- **`tests/unit/luaModuleCompletion.test.ts`** [NEW]: Tests Lua module completion item creation.

## Known Local Environment

- VS Code CLI: `C:\Users\caioh\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd`
- Physical device: `COM7`, baud `115200`, Silicon Labs CP210x.
- Firmware checkout: `C:\Users\caioh\src\nodemcu-firmware`
- esptool: `python -m esptool` version 5.3.0

## Misc Notes

- Vitest prints a `poolOptions` deprecation warning — it's noise, tests still pass.
- There is a `src/init.lua` from an old CDP test run. It's unrelated to the live-edit fix.
- The log file `build_debug.log` has debug `appendFileSync` calls in `doBuild()` — they can be cleaned up later but do not affect functionality.
