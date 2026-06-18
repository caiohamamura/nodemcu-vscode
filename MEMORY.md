# NodeMCU VSCode TODO Handoff

Last updated: 2026-06-08 (evening).

## 2026-06-08 Update (evening): Transactional src/ Sync + Output Channel Visibility

Features implemented and verified on real hardware (`COM7`, Silicon Labs CP210x):

### Transactional save flow
- When `[sync] last_timestamp` is empty, saving a file triggers `mirrorSrcToDevice` (full mirror).
- Once populated, saves call `doUploadSingleFile` — uploads only the single changed file.
- File deletions (`onDidDeleteFiles`) call `handleFileDelete` → `removeWithFallback`.
- Timestamp updates via `updateSyncTimestamp()` after each successful operation.
- Verified: second save shows "uploaded init.lua" (not "synced 2 operation(s)").

### Bug fix: Device UUID clobbering
- `updateSyncTimestamp(cfg)` received stale `cfg` captured before `ensureKnownDevice`
  replaced `cachedConfig` with the UUID. Result: `[devices] uuids=` was emptied on every save.
- **Fix:** `updateSyncTimestamp()` now re-reads `cachedConfig` via `getConfigOrNull()`
  instead of using the caller-supplied reference.
- `scheduleSrcSync` also fixed to pass `currentCfg` instead of outer `cfg` to `doUploadSingleFile`.
- Verified on COM7: UUID `483fdaa440b8` persisted across multiple saves — no dialog reappeared.

### Output channel visibility
- Added `outputChannel.show(true)` + timestamped `appendLine` to all action entry points:
  `mirrorSrcToDevice`, `doUploadSingleFile`, `handleFileDelete`, `scheduleSrcSync`,
  `doInitProject`, `doRegenerateLuaApi`, `doAddLuaModule`, `doToggleLuaModule`,
  `doToggleCModule`, `doSelectPort`, `doRefreshExplorer`, `doOpenIni`.
- Functions already wrapped in `commandWithOperation()` (which auto-calls `showOperationLog`)
  were left unchanged.

### Files changed
- `src/extension.ts`:
  - `updateSyncTimestamp` no longer takes `cfg`, re-reads from `cachedConfig`
  - `scheduleSrcSync` passes `currentCfg` instead of outer `cfg`
  - All callers updated: `mirrorSrcToDevice`, `doUploadSingleFile`, `handleFileDelete`
  - `outputChannel.show(true)` added to 11 entry points
  - `doUploadSingleFile` moved `remoteName` computation earlier to use in the log line
- `src/config/nodemcuIni.ts`: Added `SyncSection`, `last_timestamp` field (from earlier session)
- `tests/unit/nodemcuIni.test.ts`: Sync section parsing tests
- `tests/unit/srcMirror.test.ts`: getFilesRecursively + planMirrorSync edge cases
- `tests/integration/managers.test.ts`: NodemcuTool transactional flows
- `README.md`: Updated features, quick start, commands, configuration, test counts
- `AGENTS.md`: Updated handoff context (transactional sync, UUID fix, output channel)
- `MEMORY.md`: This file
- `.gitignore`: Added `.claude/SESSIONS/`

### Test counts validated on COM7
- `npm run typecheck` ✓
- `npm run build` ✓ (212.7kb)
- `npm run test:unit` — 165 passed (20 files)
- `npm run test:integration` — 26 passed (3 files)
- Real device transactional flow verified: UUID persisted, timestamp updated, only single file uploaded

### Known local environment
- VS Code CLI: `C:\Users\caioh\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd`
- Physical device: `COM7`, baud `115200`, Silicon Labs CP210x (`Silicon Labs CP210x USB to UART Bridge`)
- Firmware checkout: `C:\Users\caioh\src\nodemcu-firmware`
- esptool: `python -m esptool` version 5.3.0

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

## Memory files (memory/)
- [esp8266-tls-heap-budget](memory/esp8266-tls-heap-budget.md) — TLS handshake needs ~28KB peak; big dofile chunks OOM HTTPS; no sjson, parse with patterns.
- [serial-repl-paste-constraints](memory/serial-repl-paste-constraints.md) — REPL per-line chunks lose locals; do...end wrap; base64 SPIFFS upload; 256B line limit.
- [lfs-firmware-luaccross-quirks](memory/lfs-firmware-luaccross-quirks.md) — LFS host-tool PATH `--64` clash, lua version match, fork CMakeLists bugs (luac-assert lua53-only; lua53 -f emits no flash image → LFS needs lua51).
