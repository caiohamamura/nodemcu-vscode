# NodeMCU VSCode Extension — Agent Guide

A single source of truth for any AI agent (Claude Code, opencode, etc.) working in this
repository. Read this first; it covers build, test, source layout, conventions, gotchas,
and the current handoff context.

> The user-facing overview lives in `README.md`. Architecture, handoff context, and
> test/automation internals live here. If you only have time for one file, read this one.

---

## 1. What this project is

A VS Code extension (`displayName: "NodeMCU"`, `name: "nodemcu-vscode"`) that does
end-to-end Lua firmware development for **NodeMCU / ESP8266**:

- Builds firmware from a NodeMCU firmware checkout via CMake / Ninja / Make.
- Flashes firmware to a connected ESP8266 via `esptool.py` / `esptool`.
- Uploads / downloads / removes Lua files on the device via `nodemcu-tool`.
- Lists available C and Lua modules in the sidebar (with checkboxes) and writes
  selection back to `nodemcu.ini`.
- Generates `.vscode/nodemcu-api.lua` and `.luarc.json` so the bundled
  `sumneko.lua` language server gives full IntelliSense for NodeMCU globals.

**Critical design choice:** the extension **does not require users to clone
nodemcu-firmware**. It downloads and caches a known-good archive into the VS Code
extension global storage on first use. A custom local checkout is only needed if
the user deliberately sets `firmware_path` in `nodemcu.ini` or
`nodemcu-vscode.firmwarePath` in settings.

---

## 2. Quick reference

### 2.1 Build / test commands (order matters)

```bash
npm run typecheck    # tsc --noEmit (strict: noUnusedLocals, noUnusedParameters)
npm run build        # esbuild bundles src/extension.ts → dist/extension.js (cjs, node18)
npm run test:unit    # vitest run tests/unit  (87 tests, ~0.5s)
npm run test:integration   # vitest run tests/integration  (19 tests, ~1.3s)
npm run test:e2e     # spawns VS Code Extension Development Host; mostly skipped without hardware
npm test             # runs all three
npm run watch        # esbuild --watch
npm run package      # npx @vscode/vsce package → .vsix
```

`typecheck` and `build` are independent (esbuild does not typecheck). Run both.
The `lint` script is just `tsc --noEmit`; lint == typecheck in this repo.

### 2.2 Host platform

Developed on **Windows (PowerShell 7+)**. Use `;` instead of `&&` when chaining
PowerShell commands to avoid syntax errors. Use `path.join` in cross-platform
code (see `tests/unit/paths.test.ts`).

### 2.3 Where VS Code launches the extension from

After `npm run build`, VS Code loads `dist/extension.js` (see `package.json#main`).
Any code change requires a rebuild + window reload (or `npm run watch` + reload).

---

## 3. Repository map

```
.
├── AGENTS.md                       ← this file (agent handoff + internals)
├── CLAUDE.md                       ← short pointer for Claude Code
├── README.md                       ← user-facing docs (project, features, quick start)
├── package.json                    ← extension manifest, deps, scripts, contrib
├── package-lock.json               ← npm lockfile
├── pnpm-workspace.yaml             ← pnpm build permissions (serialport native)
├── pnpm-lock.yaml / bun.lock       ← alternate lockfiles (pinned, not used by default)
├── tsconfig.json                   ← ES2022, Node16, strict
├── vitest.config.ts                ← single-fork pool, globals, 60s timeout
├── esbuild.config.mjs              ← bundles src/extension.ts → dist/extension.js
├── .vscodeignore                   ← MUST NOT ignore node_modules / dist (see §6.2)
├── .vscode/settings.json           ← personal editor prefs (parquet/csv viewer)
│
├── src/                            ← production code
│   ├── extension.ts                ← activate(), all command handlers, tree providers
│   ├── build/                      ← build pipeline
│   │   ├── buildManager.ts         ← cmake configure + build orchestration
│   │   ├── toolchain.ts            ← locate cmake/python/ninja/make; emit commands
│   │   ├── userModulesWriter.ts    ← generate/parse app/include/user_modules.h
│   │   └── outputParser.ts         ← GCC + CMake error → CompileProblem[]
│   ├── config/                     ← nodemcu.ini
│   │   ├── nodemcuIni.ts           ← parse/serialize/save/load, defaults, setters
│   │   └── configWatcher.ts        ← fs.watch + 200ms debounce
│   ├── firmware/
│   │   └── managedFirmware.ts      ← download/extract/patch the bundled firmware
│   ├── flash/
│   │   ├── flashManager.ts         ← esptool.py write_flash (or python -m esptool)
│   │   └── serialDiscovery.ts      ← list serial ports, with fakes for tests
│   ├── luaApi/
│   │   └── apiFiles.ts             ← generate .vscode/nodemcu-api.lua + .luarc.json
│   ├── luaPicker/
│   │   ├── moduleList.ts           ← scan firmware/lua_modules + app/modules
│   │   └── luaModuleResolver.ts    ← resolve local/remote lua module sources
│   ├── status/
│   │   └── statusBar.ts            ← StatusEmitter (idle/configuring/building/...)
│   ├── types/
│   │   └── ini.d.ts                ← ambient module declaration for "ini"
│   ├── upload/
│   │   └── nodemcuTool.ts          ← wraps nodemcu-tool (upload/download/remove/fsinfo)
│   └── util/
│       ├── paths.ts                ← firmware-relative path helpers
│       └── shell.ts                ← spawn wrapper with onStdout/onStderr + quoting
│
├── tests/
│   ├── unit/                       ← fast, no I/O outside tmp dirs (10 files, 87 tests)
│   │   ├── apiFiles.test.ts
│   │   ├── luaModuleResolver.test.ts
│   │   ├── managedFirmware.test.ts
│   │   ├── nodemcuIni.test.ts
│   │   ├── outputParser.test.ts
│   │   ├── packageManifest.test.ts
│   │   ├── paths.test.ts
│   │   ├── shell.test.ts
│   │   ├── toolchain.test.ts
│   │   └── userModulesWriter.test.ts
│   ├── integration/                ← fakes the shell (3 files, 19 tests)
│   │   ├── configWatcher.test.ts
│   │   ├── managers.test.ts        ← BuildManager, FlashManager, NodemcuTool
│   │   └── moduleList.test.ts
│   ├── e2e/                        ← requires real toolchain / hardware / IDE
│   │   ├── build.test.ts           ← real CMake + nodemcu-firmware repo
│   │   ├── cdp_e2e.test.ts         ← launches EDH, CDP drives UI
│   │   ├── device.test.ts          ← real ESP8266 over USB
│   │   └── device_cdp_e2e.test.ts  ← real device + CDP-driven EDH
│   └── fixtures/
│       └── fake-firmware/          ← minimal firmware tree for unit/integration tests
│           ├── CMakeLists.txt
│           ├── app/{coap,dht,u8g2lib,websocket}/{CMakeLists.txt or .c}
│           ├── app/modules/{mqtt,wifi}.c
│           ├── lua_modules/bh1750/{bh1750.lua,bh1750_Example1.lua}
│           └── tools/toolchains/esptool.py
│
├── resources/
│   ├── icons/nodemcu.svg
│   ├── snippets/lua.json           ← 5 Lua snippets: ninit, nwifi, nmqtt, nhttp, ntmr
│   └── templates/nodemcu.ini       ← template written by "Initialize Project"
│
├── scripts/
│   └── hardware-e2e.ts             ← standalone real-device probe (build/flash/Lua)
│
├── .claude/SKILLS/                 ← custom Agent Skills (see §7)
│   └── devtools-automation/        ← CDP-based UI automation for VS Code EDH
│
├── e2e-setup.js                    ← one-off setup: workspace + fake firmware (test-only)
├── e2e-clean-setup.js              ← same as above but without seeded firmware
│
├── dist/                           ← esbuild output (gitignored normally, but kept in
│                                     .vscodeignore is configured to ship it — see §6.2)
├── node_modules/                   ← deps (serialport is native; prebuilt)
└── (logs)                          ← build_debug.log, ide-launch.log, c_modules_debug.log
                                      (rotated by gitignore pattern *.log)
```

---

## 4. Source module reference

### 4.1 `src/extension.ts` (the brain, ~1340 lines)

Owns: command registration, all tree-view providers, status bar items, config cache,
managed-firmware promise, port selection, upload logic, Lua API regeneration.

Key symbols and their line ranges:

| Symbol | Purpose | Line |
| --- | --- | --- |
| `LEGACY_DEFAULT_FIRMWARE_PATH` | The string `"../nodemcu-firmware"` we silently treat as empty | 38 |
| `class AsyncTreeProvider` | Generic `vscode.TreeDataProvider` with debounced async loader | 40 |
| `deviceExplorerProvider / luaModulesProvider / cModulesProvider` | Top-level tree providers | 102 |
| `existingIniPath()` / `getIniPath()` / `getWorkspaceRoot()` | INI discovery: workspace, one-level subdirs, then parent walk from active editor | 106 |
| `getConfigOrNull()` | Cached loader; `null` if no `nodemcu.ini` | 149 |
| `getFirmwarePath()` | Cached async resolver; reads `nodemcu-vscode.firmwarePath` setting → ini → triggers `ensureManagedFirmware()` | 164 |
| `setStatus()` / `updatePortStatusBar()` | Drives the two status bar items | 214 / 221 |
| `doBuild()` / `doFlash()` / `doBuildAndFlash()` | Command palette handlers | 341 / 386 / 419 |
| `doInitProject()` | Writes `nodemcu.ini` + `init.lua`, starts `ConfigWatcher` | 424 |
| `doUploadFile()` / `doUploadChanges()` | `src/`-driven and mtime-tracked uploads | 488 / 651 |
| `doSyncLuaModules()` | Compiles + uploads `[lua_modules]` entries as `.lc` | 826 |
| `doRegenerateLuaApi()` | Writes `.vscode/nodemcu-api.lua` + `.luarc.json` | 861 |
| `doAddLuaModule()` / `doToggleLuaModule()` / `doToggleCModule()` | Tree-view actions | 875 / 908 / 932 |
| `buildDeviceExplorerProvider()` | Two children: `Serial Ports` (with click-to-select) + `Device Files` (from `nodemcu-tool fsinfo`) | 985 |
| `buildLuaModulesProvider()` | Lists firmware `lua_modules/`, checkboxes bound to `cfg.lua_modules` | 1087 |
| `buildCModulesProvider()` | Lists `app/modules/*.c` (core) + named optional + named libraries, checkboxes bound to `cfg.c_modules` | 1135 |
| `activate()` | Wires everything; registers `cTreeView.onDidChangeCheckboxState` and `luaTreeView.onDidChangeCheckboxState` to `doToggleCModule` / `doAddLuaModule` | 1236 |

`doBuild()` and `doFlash()` short-circuit with the error
`"No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first."` when
`getConfigOrNull()` returns null. This is the error path currently failing in the
Extension Development Host (see §9).

### 4.2 Other modules (one-line summaries)

| File | Exports | Notes |
| --- | --- | --- |
| `src/build/buildManager.ts` | `BuildManager` | Diffs `user_modules.h`; if C modules added/removed, `cmake -S` reconfigures, then `cmake --build`. Returns `BuildResult { success, problems, summary, binPaths, durationMs, needsReconfigure, modulesChanged }`. |
| `src/build/toolchain.ts` | `ToolchainLocator`, `cmakeConfigureCommand`, `cmakeBuildCommand`, `esptoolFlashCommand`, `normalizeFlashSize` | Detects Ninja > MSYS Makefiles > NMake > MinGW > Unix Makefiles; normalizes `4M` → `4MB`. |
| `src/build/userModulesWriter.ts` | `generateUserModulesHeader`, `writeUserModulesHeader`, `readSelectedModules`, `diffSelectedModules`, `isCModulesConfigChanged` | Hardcoded `KNOWN_MODULES` set; emits `LUA_USE_MODULES_<NAME>` defines. |
| `src/build/outputParser.ts` | `parseProblems`, `summarize`, `extractModuleBuildSummary` | Pure regex; no vscode dependency. |
| `src/config/nodemcuIni.ts` | `parseIni`, `serializeIni`, `loadConfig`, `saveConfig`, `defaultConfig`, `setCModule`, `setLuaModule`, `getLuaModuleEntries` | Sections: `[nodemcu]`, `[c_modules]`, `[lua_modules]`, `[flash]`, `[build]`. |
| `src/config/configWatcher.ts` | `ConfigWatcher` | `fs.watch` + 200ms debounce; swallows parse errors silently. |
| `src/firmware/managedFirmware.ts` | `ensureManagedFirmware`, `MANAGED_FIRMWARE_TAG`, `MANAGED_FIRMWARE_URL` | Downloads zip, extracts, hydrates 3 submodules, applies two compatibility patches (`app/nodemcu-vscode-newlib.c`, `tools/luac_cross/nodemcu-vscode-luac-assert.c`), writes `.nodemcu-vscode-managed-firmware.json` marker. |
| `src/flash/flashManager.ts` | `FlashManager` | Prefers `firmware/tools/toolchains/esptool.py`; falls back to `python -m esptool`. Standard `0x00000` / `0x10000` mapping. |
| `src/flash/serialDiscovery.ts` | `SerialDiscovery` | Tries `serialport`, then PowerShell `SerialPort::GetPortNames` on Windows, then `/dev/tty*` glob on Linux. Honors `NODEMCU_VSCODE_FAKE_SERIAL_PORTS` env var (JSON array of strings or `{path, manufacturer, ...}`). |
| `src/luaApi/apiFiles.ts` | `generateLuaApiFile`, `generateLuaRc`, `writeLuaRc` | Hardcoded `KNOWN_GLOBALS` descriptions for ~30 modules; emits `---@meta` + `---@class NodeMCUModule` annotations. |
| `src/luaPicker/moduleList.ts` | `listLuaModulesFromFirmware`, `listCModules` | `LuaModuleInfo` has `mainFile` + `examples`; `CModuleInfo` has `category: "core" \| "optional" \| "library"`. The optional list is hardcoded (`coap`, `dht`, `http`, `mqtt`, `pcm`, `sjson`, `tsl2561`, `websocket`); libraries are `u8g2`, `ucg`. |
| `src/luaPicker/luaModuleResolver.ts` | `resolveLuaModule`, `resolveAllLuaModules`, `validateLuaModuleSource` | Search order: absolute → `workspaceRoot/<source>` → `firmware/lua_modules/<name>/<basename>` → `firmware/lua_modules/<source>`. Rejects `..` paths and invalid URLs. |
| `src/status/statusBar.ts` | `StatusEmitter` | `EventEmitter` subclass; states: `idle`, `configuring`, `building`, `flashing`, `uploading`, `success`, `error`. |
| `src/upload/nodemcuTool.ts` | `NodemcuTool` | Spawns `node <bin/nodemcu-tool.js>`; honors `NODEMCU_VSCODE_NODEMCU_TOOL` env var (path to script) for test injection. `listFiles` parses JSON first, falls back to text. |
| `src/util/paths.ts` | `resolveFirmwarePath`, `defaultBuildDir`, `userModulesHeader`, `esptoolScript`, `luaModulesDir`, `appModulesDir`, `binOutput`, `cModuleNameFromFile`, `isOptionalCModule` | Pure path helpers; no I/O except `fs.existsSync` for the optional C-module check. |
| `src/util/shell.ts` | `Shell`, `quoteArg`, `formatCommand`, `CommandSpec` | `spawn`-based; `windowsHide: true` by default; `which` uses `where` on Windows, `which` elsewhere. |

---

## 5. Configuration surface

### 5.1 `package.json` contributions

- **Activation events**: `workspaceContains:nodemcu.ini` + one per command.
- **View container**: `nodemcu-vscode` (activity bar) with `resources/icons/nodemcu.svg`.
- **Views**:
  - `nodemcu.deviceExplorer` — Device Explorer
  - `nodemcu.projectTasks` — Project Tasks
  - `nodemcu.luaModules` — Lua Modules (checkboxes)
  - `nodemcu.cModules` — C Modules (checkboxes)
- **Commands**: 17 commands, prefixed `nodemcu-vscode.*`. Keybindings: `Ctrl+Shift+B` (build), `Ctrl+Alt+B` (build & flash).
- **Context menus**: `view/item/context` adds `uploadFile` (Lua modules), `toggleCModule` (C modules), `downloadFile` / `deleteFile` / `refreshExplorer` (device files).
- **Settings** (`nodemcu-vscode.*`):
  - `src` (default `"src"`) — directory to watch and auto-upload.
  - `firmwarePath` (default `"../nodemcu-firmware"`, treated as empty — see `LEGACY_DEFAULT_FIRMWARE_PATH`).
  - `port` (default `""`) — overrides `nodemcu.ini` port.
  - `pythonPath` (default `"python"`), `cmakePath` (default `"cmake"`).
  - `autoInstallNodemcuTool` (default `true`), `outputVerbose` (default `false`).
- **Snippets** (`resources/snippets/lua.json`): `ninit`, `nwifi`, `nmqtt`, `nhttp`, `ntmr`.
- **extensionPack**: `sumneko.lua` (suggested, not required).

### 5.2 `nodemcu.ini` sections

```ini
[nodemcu]
firmware_path =                  # empty → use managed firmware
lua_version = 53                 # 51 or 53
lua_number_integral = false      # mutually exclusive with lua_number_64bits
lua_number_64bits = false
port =                           # e.g. /dev/ttyUSB0, COM3
baud = 115200
upload_baud = 460800
flash_mode = dio                 # dio|qio|dout|qout
flash_freq = 40m                 # 40m|26m|20m|80m
flash_size = 1M                  # 1M|4M|512K|... or "detect"/"keep"
parallel = true
verbose = false
src = src                        # local dir to auto-upload

[c_modules]                      # key = module name (lowercased), value = true/false
adc = true
wifi = true
node = true
; coap = false

[lua_modules]                    # key = name, value = local path or https URL
bh1750 = lua/bh1750.lua
gossip = https://example.com/gossip.lua

[flash]
extra_files = spiffs.bin@0x100000  # comma list of "path@offset"

[build]
parallel = true
verbose = false
```

The `resources/templates/nodemcu.ini` is the bootstrap template. The default
template currently still has the legacy `firmware_path = ../nodemcu-firmware`
— this is a known wart; `extension.ts:170` strips it on read.

### 5.3 Managed firmware

- URL: `https://github.com/caiohamamura/nodemcu-firmware/archive/refs/tags/luac_cross_optional.zip`
- Tag: `mbedtls-2.28.10-beta` (constant in `src/firmware/managedFirmware.ts`).
- Storage: `context.globalStorageUri/fsPath/firmware/<tag>/`.
- Marker file: `.nodemcu-vscode-managed-firmware.json` (presence + validity of
  patched files = ready).
- Submodules hydrated: `c99-snprintf` (weiss), `u8g2` (olikraus/U8g2_Arduino),
  `ucg` (olikraus/Ucglib_Arduino).
- Patches applied:
  - `app/nodemcu-vscode-newlib.c` — provides `_malloc_r`, `_free_r`, `_realloc_r`.
    Patched into `app/CMakeLists.txt` next to `dummy.c`.
  - `tools/luac_cross/nodemcu-vscode-luac-assert.c` — provides `luaL_assertfail`.
    Patched into `tools/luac_cross/CMakeLists.txt` after `pixbuf.c`.

---

## 6. Build, package, and ship

### 6.1 Build pipeline

- `esbuild.config.mjs` → `dist/extension.js` (CommonJS, `target: node18`, sourcemaps on, tree-shaking on).
- **`external: ["vscode", "serialport"]`** — both must be external; `vscode` is provided by the host, `serialport` has a native binding that esbuild cannot bundle.
- `src/types/ini.d.ts` provides a minimal ambient `module "ini"` declaration.
- `tsconfig.json`: `target: ES2022`, `module: Node16`, `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. `paths.vscode` → `./node_modules/@types/vscode` (so unit tests can import it).

### 6.2 VSIX packaging gotchas (read this before `npm run package`)

- **`.vscodeignore` MUST keep `node_modules/` and `dist/`** so `vsce` packages
  them. If they are ignored, the VSIX silently lacks the native `serialport`
  binding and the extension crashes on activation in a normal VS Code install.
  The current `.vscodeignore` correctly excludes `tests/`, `src/`, `tsconfig.json`,
  `esbuild.config.mjs`, lockfiles, and logs.
- `npm run package` uses `npx @vscode/vsce package`. It requires
  `npm run build` and `npm run typecheck` to have run cleanly.
- Never edit `package.json` with regex / blind replacements — `npm` parses it
  strictly and a stray comma breaks every script. Always round-trip via
  `JSON.parse(stringify(...))` if you must rewrite it.

### 6.3 Native modules

- `serialport` 12.x and `@serialport/bindings-cpp` need to be built natively.
  `pnpm-workspace.yaml` whitelists their `allowBuilds`. With `npm install` the
  prebuilt binary is usually fetched; if not, `npm rebuild serialport` is the
  fallback.
- If activation fails with "Cannot find module 'serialport'", check that
  `dist/extension.js` does not have `require("serialport")` rewritten to a
  shimmed path — the esbuild `external` is what keeps it as a real `require`.

---

## 7. Tests

### 7.1 Layout

- `tests/unit/*.test.ts` (10 files, 87 tests) — pure logic + `mkdtemp` I/O.
- `tests/integration/*.test.ts` (3 files, 19 tests) — fakes `Shell` to drive
  `BuildManager` / `FlashManager` / `NodemcuTool`; uses `tests/fixtures/fake-firmware/`.
- `tests/e2e/*.test.ts` (4 files) — run only when prerequisites are met.

### 7.2 vitest config

`vitest.config.ts` uses `pool: "forks"`, `singleFork: true`, `testTimeout: 60_000`,
`hookTimeout: 60_000`. The single-fork option is intentional so test files don't
fight over `cwd` / `process.env` mutations.

### 7.3 e2e suites

| File | What it does | Skipped unless… |
| --- | --- | --- |
| `tests/e2e/build.test.ts` | Configures + builds with CMake, asserts `bin/0x00000.bin` and `bin/0x10000.bin` exist, checks incremental rebuild and C-module-add regenerate. | Real `cmake`, real `python`, sibling `../nodemcu-firmware` checkout with `CMakeLists.txt`. |
| `tests/e2e/cdp_e2e.test.ts` | Spawns a fresh VS Code Extension Development Host with isolated `--user-data-dir` / `--extensions-dir` / `--remote-debugging-port`, seeds `tests/fixtures/fake-firmware` into `globalStorage`, injects a `fake-nodemcu-tool.js` via `NODEMCU_VSCODE_NODEMCU_TOOL` and `NODEMCU_VSCODE_FAKE_SERIAL_PORTS` to fake COM42, then drives the UI through CDP. Asserts project init, view visibility, checkbox toggles, ini updates, `user_modules.h` regeneration, upload, refresh, delete. | Local VS Code install + `sumneko.lua` install (best effort). |
| `tests/e2e/device.test.ts` | Builds, flashes, verifies chip-id pre/post, reads back firmware, runs REPL, incrementally rebuilds with new C module, checks banner lists module. | Real ESP8266, `../nodemcu-firmware`, cmake, python, esptool, `id -g` returns 20 (dialout group). |
| `tests/e2e/device_cdp_e2e.test.ts` | Same as `device.test.ts` but uses CDP-driven Extension Development Host to run build / flash / upload / verify. | Real ESP8266, `../nodemcu-firmware`, cmake, python, esptool, the serial port exists, local VS Code install. |

The e2e tests use a `beforeAll` / `afterAll` pattern with `HOLD_MS` env var
(`NODEMCU_VSCODE_E2E_HOLD_MS`) to keep the Extension Development Host alive after
the suite finishes — useful for live debugging.

### 7.4 Test-only environment variables

| Variable | Consumed by | Effect |
| --- | --- | --- |
| `NODEMCU_VSCODE_NODEMCU_TOOL` | `NodemcuTool.command()` | Override path to the `nodemcu-tool` entry script. Used by `cdp_e2e.test.ts` to point at a fake. |
| `NODEMCU_VSCODE_FAKE_SERIAL_PORTS` | `SerialDiscovery.list()` | JSON array (`["/dev/ttyUSB0"]` or `[{path, manufacturer, ...}]`) returned in place of `serialport.SerialPort.list()`. |
| `NODEMCU_VSCODE_FAKE_NODMCU_TOOL_STATE` | The bundled fake `nodemcu-tool.js` only | State dir for the fake device's "filesystem". |
| `NODEMCU_VSCODE_E2E_CDP_PORT` | `cdp_e2e.test.ts` / `device_cdp_e2e.test.ts` | CDP remote debugging port (default 9237 / 9238). |
| `NODEMCU_VSCODE_E2E_SERIAL_PORT` | `device_cdp_e2e.test.ts` | Serial port (default `/dev/ttyUSB0`). |
| `NODEMCU_VSCODE_E2E_SERIAL_BAUD` | `device_cdp_e2e.test.ts` | Baud rate (default 115200). |
| `NODEMCU_VSCODE_E2E_HOLD_MS` | both CDP e2e tests | Keep EDH alive after `afterAll`. |
| `VSCODE_E2E_EXECUTABLE` | both CDP e2e tests | Override path to VS Code executable. |

---

## 8. Debugging recipes

### 8.1 "Is the rebuilt `dist/extension.js` actually being loaded?"

In the Extension Development Host:

1. `Help → Toggle Developer Tools` (or `Ctrl+Shift+I`).
2. Console: type `require("module")._cache` and look for paths — or simpler, add a
   unique `console.log("[nodemcu] build=<ISO timestamp>")` at the top of
   `src/extension.ts` and rebuild, then reload the window.

### 8.2 Tail the running log file

`doBuild()` (and the rest of the runtime) append to a hardcoded log file:

```
C:\Users\caioh\src\vscode\nodemcu-vscode\build_debug.log
```

(`src/extension.ts:342`). Tail it with `Get-Content -Wait` or any log viewer.
The `c_modules_debug.log` is written by `moduleList.ts:63` adjacent to the
firmware root.

### 8.3 Drive the UI with CDP (the right way)

```bash
# 1. Launch a fresh EDH (see §9 for the launch flags)
# 2. Verify it's reachable
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js get-state
# 3. Toggle a C module
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js toggle wifi
# 4. Run a command
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js run-command "NodeMCU: Initialize Project"
# 5. Stream logs
node .claude/SKILLS/devtools-automation/scripts/cdp-control.js capture-console
```

The skill at `.claude/SKILLS/devtools-automation/SKILL.md` is the canonical
documentation; use the `skill` tool to load it.

### 8.4 Avoid stale renderer state

CDP commands can target a stale Extension Development Host if you have several
open. Before running, hit `http://127.0.0.1:<port>/json` and confirm the target's
title contains `[Extension Development Host]`. If it doesn't, run
`reload-window` or relaunch the host.

---

## 9. Current handoff context (read this last)

The extension is still failing in the Extension Development Host despite the
most recent attempted fixes. Concretely:

- **Build & Flash** still reports
  `No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first.`
  Even after running *Initialize Project*. Hypothesis: `getConfigOrNull()` is
  populated but `cachedConfig` is being clobbered by a stale `ConfigWatcher`,
  or the Extension Development Host is loading an old `dist/extension.js`.
- **Lua Modules** view is empty. It should list every directory in
  `firmware/lua_modules/` with a checkbox.
- **C Modules** view is empty. Same as above for `app/modules/*.c` and the
  hardcoded optional/library list.
- **Device Explorer** still shows a static `NodeMCU (port)` placeholder instead
  of actually enumerating serial ports and listing the on-device files via
  `nodemcu-tool fsinfo --json`.

### 9.1 Things to verify before "fixing" anything

1. The Extension Development Host is loading the freshly built `dist/extension.js`.
   Add a timestamp log at the top of `activate()` and reload.
2. The workspace actually contains a `nodemcu.ini`. The discovery in
   `extension.ts:106-147` walks workspace folders → one-level subdirs → parent
   chain from the active editor. If the workspace root has hidden symlinks, the
   `fs.readdirSync(..., { withFileTypes: true })` may throw silently.
3. `getFirmwarePath()` is awaiting `ensureManagedFirmware()` correctly. The
   `getLuaModulesProvider` and `getCModulesProvider` must call
   `await getFirmwarePath()` and return early if `fw` is null with a "Managed
   firmware unavailable" message.
4. `cachedConfig` is in sync with what's on disk. `ConfigWatcher.onChange`
   overwrites `cachedConfig`; make sure the `doBuild` / `doFlash` paths read
   the cached value but the file watcher's debounce hasn't lost an edit.
5. `doBuild()` should not return early on the "no config" path if a project
   was just initialized in the same session; the activate-time `getConfigOrNull()`
   should be reactive to `doInitProject()` calling `cachedConfig = loadConfig(...)`
   (it does — verify it's running).

### 9.2 Firmware policy (do not regress)

- `firmware_path` empty → use managed firmware (download `mbedtls-2.28.10-beta`).
- The literal string `../nodemcu-firmware` from older configs is **legacy noise**
  and should be silently treated as empty (see
  `src/extension.ts:170` `LEGACY_DEFAULT_FIRMWARE_PATH`).
- Only honor a non-empty `firmware_path` when the user has clearly set it.

### 9.3 Expected end state

- `NodeMCU: Build & Flash` produces `bin/0x00000.bin` and `bin/0x10000.bin` and
  flashes them without manual firmware cloning.
- `Lua Modules` and `C Modules` show rows the moment managed firmware is ready
  (or sooner with a "loading" placeholder).
- `Device Explorer` actively enumerates `SerialPort.list()` and (if a port is
  selected and `nodemcu-tool` is installed) the device file list.

### 9.4 Non-obvious gotchas

- The `resources/templates/nodemcu.ini` still references the legacy
  `../nodemcu-firmware` default. If the template is what users see after
  *Initialize Project*, consider rewriting it to default to empty
  `firmware_path =`.
- `package.json#contributes.configuration["nodemcu-vscode.firmwarePath"]` has
  the legacy `"../nodemcu-firmware"` default too. Change the default to `""`
  if you want new users to skip the legacy string entirely.
- `tests/e2e/cdp_e2e.test.ts` is the contract that proves the runtime works.
  Use it as a regression check after any change to `extension.ts`'s activation
  flow.
- The fake firmware under `tests/fixtures/fake-firmware/` does NOT contain the
  patches; `ensureManagedFirmware` applies them on first call. The CDP e2e
  test seeds the missing submodule files manually so the ready check passes
  on the first try.
- `git status` will routinely show `package-lock.json` as dirty because
  `pnpm-lock.yaml` and `bun.lock` are also committed. Don't "fix" this.
- The repo is 14 commits ahead of `origin/main`; the user is iterating locally
  and hasn't pushed. Don't push unless explicitly asked.
