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
- Live-edits device files through an in-memory `nodemcu-live:` filesystem and
  uploads edited content on save.
- Transactionally syncs the local `src/` directory to the device: first save
  does a full mirror; subsequent saves upload only the changed file. File
  deletions are mirrored too.
- Keeps a bottom-panel **NodeMCU Serial** console open and connected so users can
  follow serial output in real time. The regular **NodeMCU** output channel still
  receives extension logs but does not steal focus automatically.
- Auto-selects a serial port when detection is unambiguous, preserving an
  available configured port.
- Lists available C and Lua modules in the sidebar (with checkboxes) and writes
  selection back to `nodemcu.ini`.
- Offers Lua module autocomplete snippets that enable `[lua_modules]` entries
  and sync them to the device.
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
npm run test:unit    # vitest run tests/unit  (165 tests, ~5s)
npm run test:integration   # vitest run tests/integration  (26 tests, ~24s)
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
│   ├── device/
│   │   └── liveEditFs.ts           ← in-memory nodemcu-live: filesystem for Device Files live edit
│   ├── firmware/
│   │   └── managedFirmware.ts      ← download/extract/patch the bundled firmware
│   ├── flash/
│   │   ├── autoPort.ts             ← choose when detected serial ports can be auto-selected
│   │   ├── flashManager.ts         ← esptool.py write_flash (or python -m esptool)
│   │   └── serialDiscovery.ts      ← list serial ports, with fakes for tests
│   ├── luaApi/
│   │   └── apiFiles.ts             ← generate .vscode/nodemcu-api.lua + .luarc.json
│   ├── luaPicker/
│   │   ├── luaModuleCompletion.ts  ← Lua require() completion item helpers
│   │   ├── moduleList.ts           ← scan firmware/lua_modules + app/modules
│   │   └── luaModuleResolver.ts    ← resolve local/remote lua module sources
│   ├── status/
│   │   └── statusBar.ts            ← StatusEmitter (idle/configuring/building/...)
│   ├── types/
│   │   └── ini.d.ts                ← ambient module declaration for "ini"
│   ├── upload/
│   │   └── nodemcuTool.ts          ← wraps nodemcu-tool (upload/download/remove/fsinfo)
│   └── util/
│       ├── commandQueue.ts         ← FIFO command queue with cancel support
│       ├── paths.ts                ← firmware-relative path helpers
│       └── shell.ts                ← spawn wrapper with onStdout/onStderr + quoting
│
├── tests/
│   ├── unit/                       ← fast, no I/O outside tmp dirs (20 files, 173 tests)
│   │   ├── apiFiles.test.ts
│   │   ├── asyncTreeProvider.test.ts
│   │   ├── autoPort.test.ts
│   │   ├── commandQueue.test.ts
│   │   ├── deviceIdentity.test.ts
│   │   ├── directSerialUploader.test.ts
│   │   ├── liveEditFs.test.ts
│   │   ├── liveEditSave.test.ts
│   │   ├── luaModuleCompletion.test.ts
│   │   ├── luaModuleResolver.test.ts
│   │   ├── managedFirmware.test.ts
│   │   ├── nodemcuIni.test.ts
│   │   ├── outputParser.test.ts
│   │   ├── packageManifest.test.ts
│   │   ├── paths.test.ts
│   │   ├── serialMonitorLifecycle.test.ts
│   │   ├── shell.test.ts
│   │   ├── srcMirror.test.ts
│   │   ├── toolchain.test.ts
│   │   └── userModulesWriter.test.ts
│   ├── integration/                ← fakes the shell (3 files, 26 tests)
│   │   ├── configWatcher.test.ts
│   │   ├── managers.test.ts        ← BuildManager, FlashManager, NodemcuTool
│   │   └── moduleList.test.ts
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
| `deviceExplorerProvider / deviceFilesProvider / luaModulesProvider / cModulesProvider` | Top-level tree providers | 102 |
| `existingIniPath()` / `getIniPath()` / `getWorkspaceRoot()` | INI discovery: workspace, one-level subdirs, then parent walk from active editor | 106 |
| `getConfigOrNull()` | Cached loader; `null` if no `nodemcu.ini` | 149 |
| `getFirmwarePath()` | Cached async resolver; reads `nodemcu-vscode.firmwarePath` setting → ini → triggers `ensureManagedFirmware()` | 164 |
| `setStatus()` / `updatePortStatusBar()` | Drives the two status bar items | 214 / 221 |
| `doBuild()` / `doFlash()` / `doBuildAndFlash()` | Command palette handlers | 341 / 386 / 419 |
| `doInitProject()` | Writes `nodemcu.ini` + `init.lua`, starts `ConfigWatcher` | 424 |
| `doUploadFile()` / `doUploadChanges()` | `src/`-driven and mtime-tracked uploads | 488 / 651 |
| `doUploadAndMonitor()` | Focus/connect Serial Console, upload changed files, sync Lua modules (`F5`) | near `doSyncLuaModules()` |
| `doOpenLiveDeviceFile()` / `uploadLiveDocument()` | Device Files live edit via `nodemcu-live:` and upload-on-save | near device file commands |
| `doSyncLuaModules()` | Compiles + uploads `[lua_modules]` entries as `.lc` | 826 |
| `doRegenerateLuaApi()` | Writes `.vscode/nodemcu-api.lua` + `.luarc.json` | 861 |
| `doAddLuaModule()` / `doToggleLuaModule()` / `doToggleCModule()` | Tree-view actions | 875 / 908 / 932 |
| `buildDeviceExplorerProvider()` | Lists detected serial ports with click-to-select | 985 |
| `buildDeviceFilesProvider()` | Lists on-device files from `nodemcu-tool fsinfo --json`; click opens live edit | near `buildDeviceExplorerProvider()` |
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
| `src/device/liveEditFs.ts` | `LiveEditFileSystemProvider`, `LIVE_EDIT_SCHEME` | Writable in-memory `nodemcu-live:` documents for Device Files live edit; saves are uploaded by `extension.ts`. |
| `src/flash/autoPort.ts` | `chooseAutoPort`, `isNodeMcuLikePort` | Pure auto-selection policy: keep available configured port; otherwise select only an unambiguous single or NodeMCU-like port. |
| `src/build/toolchain.ts` | `ToolchainLocator`, `cmakeConfigureCommand`, `cmakeBuildCommand`, `esptoolFlashCommand`, `normalizeFlashSize` | Detects Ninja > MSYS Makefiles > NMake > MinGW > Unix Makefiles; normalizes `4M` → `4MB`. |
| `src/build/userModulesWriter.ts` | `generateUserModulesHeader`, `writeUserModulesHeader`, `readSelectedModules`, `diffSelectedModules`, `isCModulesConfigChanged`, `isTlsEnabled`, `setUserConfigSsl`, `writeUserConfigSsl` | Hardcoded `KNOWN_MODULES` set; emits `LUA_USE_MODULES_<NAME>` defines. `MODULE_DEPENDENCIES` force-enables deps (`tls` → `http`). `writeUserConfigSsl` toggles `CLIENT_SSL_ENABLE` / `SSL_BUFFER_SIZE` in `app/include/user_config.h` to match the `tls` module (buffer size from `[build] ssl_buffer_size`, default `16384`); `BuildManager.build` calls it and folds its return into `needsReconfigure`. |
| `src/build/outputParser.ts` | `parseProblems`, `summarize`, `extractModuleBuildSummary` | Pure regex; no vscode dependency. |
| `src/config/nodemcuIni.ts` | `parseIni`, `serializeIni`, `loadConfig`, `saveConfig`, `defaultConfig`, `setCModule`, `setLuaModule`, `getLuaModuleEntries` | Sections: `[nodemcu]`, `[c_modules]`, `[lua_modules]`, `[flash]`, `[build]`. |
| `src/config/configWatcher.ts` | `ConfigWatcher` | `fs.watch` + 200ms debounce; swallows parse errors silently. |
| `src/firmware/managedFirmware.ts` | `ensureManagedFirmware`, `MANAGED_FIRMWARE_TAG`, `MANAGED_FIRMWARE_URL` | Downloads zip, extracts, hydrates 3 submodules, applies two compatibility patches (`app/nodemcu-vscode-newlib.c`, `tools/luac_cross/nodemcu-vscode-luac-assert.c`), writes `.nodemcu-vscode-managed-firmware.json` marker. |
| `src/flash/flashManager.ts` | `FlashManager` | Prefers `firmware/tools/toolchains/esptool.py`; falls back to `python -m esptool`. Standard `0x00000` / `0x10000` mapping. |
| `src/flash/serialDiscovery.ts` | `SerialDiscovery` | Tries `serialport`, then PowerShell `SerialPort::GetPortNames` on Windows, then `/dev/tty*` glob on Linux. Honors `NODEMCU_VSCODE_FAKE_SERIAL_PORTS` env var (JSON array of strings or `{path, manufacturer, ...}`). |
| `src/luaApi/apiFiles.ts` | `generateLuaApiFile`, `generateLuaRc`, `writeLuaRc` | Hardcoded `KNOWN_GLOBALS` descriptions for ~30 modules; emits `---@meta` + `---@class NodeMCUModule` annotations. |
| `src/luaPicker/moduleList.ts` | `listLuaModulesFromFirmware`, `listCModules` | `LuaModuleInfo.name` is the **main Lua file's basename** (the require name), `dirName` is the firmware folder — they differ for misnamed folders (`lua_modules/http/httpserver.lua` → name `httpserver`, dir `http`); also has `mainFile` + `examples`. Source paths stored in ini use `dirName`; `luaModuleResolver` resolves firmware modules via `firmwarePath + source`. `CModuleInfo` has `category: "core" \| "optional" \| "library"`. The optional list is hardcoded (`coap`, `dht`, `http`, `mqtt`, `pcm`, `sjson`, `tsl2561`, `websocket`); libraries are `u8g2`, `ucg`. |
| `src/luaPicker/luaModuleCompletion.ts` | `createLuaModuleCompletionItem`, `luaModuleRequireText`, `luaModuleSource` | Builds Lua autocomplete snippets and the accept-command payload that enables/syncs modules. |
| `src/luaPicker/luaModuleResolver.ts` | `resolveLuaModule`, `resolveAllLuaModules`, `validateLuaModuleSource` | Search order: absolute → `workspaceRoot/<source>` → `firmware/lua_modules/<name>/<basename>` → `firmware/lua_modules/<source>`. Rejects `..` paths and invalid URLs. |
| `src/status/statusBar.ts` | `StatusEmitter` | `EventEmitter` subclass; states: `idle`, `configuring`, `building`, `flashing`, `uploading`, `success`, `error`. |
| `src/device/serialDeviceClient.ts` | `SerialDeviceClient` | The **active** upload/download/list/remove/run/format path over the shared serial session (the `DirectSerialUploader` is now only a fallback/test class). See §10 for the streaming upload protocol and the NodeMCU REPL constraints it must respect. |
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
  - `nodemcu.deviceFiles` — Device Files
  - `nodemcu.projectTasks` — Project Tasks
  - `nodemcu.luaModules` — Lua Modules (checkboxes)
  - `nodemcu.cModules` — C Modules (checkboxes)
  - `nodemcu.serialConsole` — bottom-panel WebviewView (`type: "webview"`) for the shared Serial Console.
- **Commands**: prefixed `nodemcu-vscode.*`, including `uploadAndMonitor`,
  `openLiveDeviceFile`, and `acceptLuaModuleCompletion`. Keybindings:
  `Ctrl+Shift+B` (build), `Ctrl+Alt+B` (build & flash), `F5` (upload and keep
  Serial Console focused), and `Delete` / `Backspace` in Device Files.
- **Context menus**: `view/item/context` adds `uploadFile` (Lua modules),
  `toggleCModule` (C modules), and `openLiveDeviceFile` / `downloadFile` /
  `deleteFile` / `runFile` / `refreshExplorer` (Device Files).
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
upload_baud = 115200
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
ssl_buffer_size = 16384            # mbed TLS record buffer when tls/CLIENT_SSL is on
```

The `resources/templates/nodemcu.ini` is the bootstrap template. The default
template currently still has the legacy `firmware_path = ../nodemcu-firmware`
— this is a known wart; `extension.ts:170` strips it on read.

### 5.5 LFS (Lua Flash Store) — opt-in, gated on a host C compiler

LFS stores Lua modules in flash and runs them with near-zero RAM overhead. The
extension exposes it only when a host C compiler is found (`detectHostCompiler`
in `toolchain.ts` → context key `nodemcu.hasHostCompiler`), because the LFS image
is built by `luac.cross`, a host tool compiled by `cc`/`gcc` (the firmware builds
it via `BUILD_HOST_TOOLS`).

- **Config**: `[build] lfs_size` (hex like `0x20000` or decimal; `0` = off,
  default off). `DEFAULT_LFS_SIZE = 0x20000` (128 KB) is written by **Enable LFS**.
  `isLfsEnabled(cfg)` is the predicate.
- **Build side** (`buildManager` + `userModulesWriter.setUserConfigLfs`): a nonzero
  `lfs_size` writes `LUA_FLASH_STORE` into `user_config.h` (a partition change →
  forces reconfigure + reflash, like the SSL toggle). `cmakeConfigureCommand`
  passes `-DBUILD_HOST_TOOLS=ON` only when LFS is on. The host tools
  (`luac.cross`, `spiffsimg`) are pre-built with a **host-clean PATH** before the
  firmware build — otherwise the host gcc grabs the xtensa `as` off PATH and dies
  with `as: unrecognized option '--64'`.
- **Image** (`build/lfsBuilder.ts`): `luac.cross -f -m <size> -o lfs.img <files>`
  over the enabled local `[lua_modules]` + `src/*.lua` (init.lua stays the SPIFFS
  bootstrap). Path helpers `luacCrossPath` / `lfsImagePath` in `util/paths.ts`.
- **Deploy** (`extension.ts deployLfsImage` + `SerialDeviceClient.flashReload`):
  upload `lfs.img`, then `node.flashreload("lfs.img")` (reboots into the new
  flash store). Commands: `enableLfs`, `disableLfs`, `buildAndDeployLfs` (palette,
  `when: nodemcu.hasHostCompiler`). On-device, LFS modules are accessed via
  `node.flashindex(name)` / `node.LFS.get(name)` (NodeMCU's `require` does not
  always wire an LFS searcher).
- **LFS-aware sync (no SPIFFS duplication).** When `lfs_size>0`, the LFS-bound
  Lua (enabled local `[lua_modules]` + `src/*.lua`, except `init.lua`) lives in the
  flash store, not SPIFFS — otherwise `require` resolves the SPIFFS `.lc` and
  bypasses LFS. So: `planMirrorSync` takes an `excludeRemoteName` predicate that
  drops those files from the upload set (and removes any remote copy);
  `reconcileLuaModulesOnDevice` removes (not uploads) their SPIFFS `.lc`;
  `doUploadSingleFile` skips an LFS-bound save and hints to run **Build & Deploy
  LFS Image**; and `deployLfsImage` removes any leftover SPIFFS `.lc`/`.lua` after
  `flashreload`. `collectLfsSources` / `lfsBoundNames` (extension.ts) are the
  single source of truth for the bound set.
- **Lua version must match.** `luac.cross` follows `-DLUA`, so the firmware and
  `luac.cross` must be the same Lua flavour or the device's LFS loader rejects the
  image. `BuildManager.luaFlavourChanged` reads the CMakeCache and forces a
  reconfigure when `lua_version`/number-mode changes so they can't drift.
- **Firmware-fork fix required (in `caiohamamura/nodemcu-firmware`, NOT this repo).**
  The root `CMakeLists.txt` `ExternalProject_Add(firmware ...)` must forward the
  Lua flags to the firmware build:
  ```cmake
  -DLUA=${LUA}
  -DLUA_NUMBER_INTEGRAL=${LUA_NUMBER_INTEGRAL}
  -DLUA_NUMBER_64BITS=${LUA_NUMBER_64BITS}
  ```
  Without this the firmware always uses the `parse_flags.cmake` default `LUA=51`
  while the outer `luac.cross` follows `-DLUA`, so a lua53 image is rejected by a
  lua51 firmware (`read error on LFS image file`). With the fix, the project
  default lua53 works end to end (hardware-verified 2026-06-18: device boots
  `Lua 5.3.6`, module runs from flash). Note: the obsolete
  `nodemcu-vscode-luac-assert.c` shim (an artifact of older managed-firmware
  patching; lua53 no longer references `luaL_assertfail`) must NOT be added to
  `tools/luac_cross/CMakeLists.txt` for lua51 — it duplicates lua51's symbol.
- **Build target.** `BuildManager` builds the firmware via the `build_all` target
  (firmware + bin image), NOT the default `all`. `all` recompiles the host tools
  under the xtensa-augmented PATH, and the firmware-rebuild mtime bump touches
  `app/modules/*.c` (shared with `luac.cross`) → those host-tool objects rebuild
  with the xtensa `as` and fail (`--64`). The LFS host tools are built separately
  with a host-clean PATH.

### 5.3 Managed firmware

- URL: `https://github.com/caiohamamura/nodemcu-firmware/archive/refs/tags/v3.1.0.zip`
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

### 5.4 Runtime interaction policies

- **Auto port selection:** keep an available configured port. If it is missing,
  or no port is configured, write a detected port to `nodemcu.ini` only when the
  choice is unambiguous: exactly one serial port or exactly one NodeMCU-like port
  (`NodeMCU`, `ESP`, `CP210`, `CH340`, `USB Serial`) among multiple ports.
  `nodemcu-vscode.port` still overrides `nodemcu.ini`; clear it to let the
  extension update project config.
- **Device Files live edit:** device file clicks open an in-memory
  `nodemcu-live:/<port>/<remote-file>` document. `onDidSaveTextDocument` uploads
  that buffer back to the same remote file with `nodemcu-tool upload`.
- **Lua module autocomplete:** accepting a firmware Lua module completion inserts
  `name = require("name")`, enables the module in `[lua_modules]`, refreshes
  views, and runs `Sync Lua Modules`.
- **Serial Console:** `nodemcu-vscode.openSerialMonitor` shows the bottom-panel
  Serial Console and connects the shared serial session. The extension owns the
  selected serial port by default while the workspace is active. Upload, delete,
  list, run, reset, and Lua module sync use the shared session; the console keeps
  reading while its input box is disabled during exclusive operations. Manual
  **Disconnect Serial Session** or **Release Serial Port** suppresses automatic
  reconnect until **Open Serial Console** or **Reconnect Serial Port** is used.
- **Upload and Monitor:** `nodemcu-vscode.uploadAndMonitor` focuses/connects the
  Serial Console, runs the changed-file upload path (which rebuilds/flashes
  first if C modules are dirty), and syncs Lua modules. It keeps the shared
  Serial Console focused instead of managing a separate terminal process.

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

- `tests/unit/*.test.ts` — pure logic + `mkdtemp` I/O, including auto-port and
  Lua completion helper coverage.
- `tests/integration/*.test.ts` — fakes `Shell` to drive
  `BuildManager` / `FlashManager` / `NodemcuTool`; uses `tests/fixtures/fake-firmware/`.
- `tests/e2e/*.test.ts` — run only when prerequisites are met (skipped otherwise,
  so `npm test` stays green):
  - `device_cdp_e2e.test.ts` — CDP-driven full UI flow against a real ESP8266
    (`NODEMCU_VSCODE_E2E_HARDWARE=1` + VS Code CLI).
  - `tls_buffer_size_e2e.test.ts` — CDP-free; builds+flashes per `[build]
    ssl_buffer_size` with `tls` enabled, runs the upstream `scratch_https.lua`
    (`http.get`) and `scratch_https3.lua` (`http.get_stream`) HTTPS scripts on the
    device, and asserts a too-small buffer fails every TLS handshake while 16384
    succeeds. Needs `NODEMCU_VSCODE_E2E_HARDWARE=1` and `NODEMCU_VSCODE_E2E_WIFI_SSID`
    (+ optional `_WIFI_PASS`); no credentials are hardcoded. Sizes via
    `NODEMCU_VSCODE_E2E_SSL_SIZES` (default `1024,16384`). Verified on a real
    ESP8266: `1024` → 0/10 TLS successes, `16384` → TLS succeeds. The firmware
    build self-downloads its xtensa toolchain; a fresh flash formats SPIFFS on
    first boot, so the script upload waits + retries.
  - `lfs_e2e.test.ts` — CDP-free; builds firmware with an LFS partition
    (`[build] lfs_size`) + `luac.cross`, flashes, compiles a sample module into an
    LFS image (`buildLfsImage`), uploads it, `node.flashreload`s, and asserts the
    module is listed by `node.LFS.list()`, resolves via `node.flashindex` (returns
    a function), executes (`ping()` → marker) and is NOT a SPIFFS file. Needs
    `NODEMCU_VSCODE_E2E_HARDWARE=1`; reuse a built firmware checkout via
    `NODEMCU_VSCODE_LFS_FIRMWARE_PATH` to skip the managed download. Defaults to
    `lua_version = 53` (override with `NODEMCU_VSCODE_LFS_LUA=51`); requires the
    firmware-fork `-DLUA` forwarding fix in §5.5. Verified on a real ESP8266 for
    both lua53 and lua51: device boots the matching Lua version and the module
    runs from flash (`pong-from-lfs`). Run with linuxbrew on PATH for cmake.

### 7.2 vitest config

`vitest.config.ts` uses `pool: "forks"`, `singleFork: true`, `testTimeout: 60_000`,
`hookTimeout: 60_000`. The single-fork option is intentional so test files don't
fight over `cwd` / `process.env` mutations.

### 7.4 Test-only environment variables

| Variable | Consumed by | Effect |
| --- | --- | --- |
| `NODEMCU_VSCODE_NODEMCU_TOOL` | `NodemcuTool.command()` | Override path to the `nodemcu-tool` entry script. Used for test injection. |
| `NODEMCU_VSCODE_FAKE_SERIAL_PORTS` | `SerialDiscovery.list()` | JSON array (`["/dev/ttyUSB0"]` or `[{path, manufacturer, ...}]`) returned in place of `serialport.SerialPort.list()`. |
| `NODEMCU_VSCODE_FAKE_NODMCU_TOOL_STATE` | The bundled fake `nodemcu-tool.js` only | State dir for the fake device's "filesystem". |
| `NODEMCU_VSCODE_LFS_FIRMWARE_PATH` | `lfs_e2e.test.ts` | Reuse an already-built firmware checkout instead of downloading the managed firmware. |

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

### 8.4 CDP DOM selectors (verified against real VS Code renderer)

| Element | Selector | Notes |
| --- | --- | --- |
| Status bar (NodeMCU build/flash status) | `#undefined_publisher\.nodemcu-vscode > a` | ID contains `undefined_publisher` in EDH context; use `[id*="nodemcu-vscode"] a` for robustness |
| Quick input box | `.quick-input-box input` | Also check `!!document.querySelector(...)` to detect if open |
| Notification toasts | `.notifications-toasts .notification-toast` | `.visible` class indicates showing; Proceed/Cancel buttons are `.notification-toast .monaco-button` |
| Proceed button (device UUID) | `.notification-toast .monaco-button` → `textContent.trim() === 'Proceed'` | Also works: `.monaco-dialog-box .monaco-button`, `.modal .monaco-button` |
| Pane header aria-label | `.pane-header` → `getAttribute('aria-label')` | e.g. "Device Files Section", "Device Explorer Section" |
| Monaco list rows | `.monaco-list-row` | Inside a `.pane` |
| Checkboxes | `.monaco-checkbox` | `classList.contains('checked')` |

### 8.5 Avoid stale renderer state

CDP commands can target a stale Extension Development Host if you have several
open. Before running, hit `http://127.0.0.1:<port>/json` and confirm the target's
title contains `[Extension Development Host]`. If it doesn't, run
`reload-window` or relaunch the host.

---

## 9. Current handoff context (read this last)

### 9.1 Transactional src/ sync (latest feature)

The extension now supports transactional sync of the `src/` directory:

1. **First save** (or when `[sync] last_timestamp` is empty) → `mirrorSrcToDevice`
   does a full mirror: format device, list remote files, upload/delete as needed
   (via `planMirrorSync`), then writes the timestamp.
2. **Subsequent saves** → `scheduleSrcSync` calls `doUploadSingleFile` which
   uploads only the saved file via `uploadWithFallback`, then updates the
   timestamp.
3. **File deletions** → `handleFileDelete` removes the remote file via
   `removeWithFallback` and updates the timestamp.

Key entry points in `src/extension.ts`:
- `scheduleSrcSync` (line ~1351): `onDidSaveTextDocument` handler, 300ms debounce
- `doUploadSingleFile` (line ~837): uploads one file when `last_timestamp` exists
- `handleFileDelete` (line ~873): `onDidDeleteFiles` handler
- `updateSyncTimestamp` (line ~825): writes `[sync] last_timestamp` to ini
- `mirrorSrcToDevice` (line ~717): full mirror path (format + plan + upload/delete)

**Content-hash change detection (the sync is byte-aware, not save-aware):**
- The watcher is scoped to `<src>/**` (a `RelativePattern` off the workspace
  root), so it only wakes for src/ changes — not node_modules/.git/build churn.
  `onDidSaveTextDocument` + the change handlers still defend with `isUriUnderSrc`.
- A sha1 of each uploaded file's bytes is stored in `workspaceState`
  (`nodemcu.uploadHashes`, keyed by absolute local path). `fileContentHash`,
  `getUploadHashes`, `saveUploadHashes` are the helpers.
- `scheduleSrcSyncUri` skips the upload entirely when the saved file's hash
  matches the stored one — a no-op Ctrl+S (which still bumps mtime) does nothing.
- `planMirrorSync` (in `src/upload/srcMirror.ts`) now takes optional
  `uploadHashes` + `hashFile` and prefers them over mtime for `changedOnly`
  planning; it falls back to mtime when no hash function is supplied or it
  returns null (so the existing tests and callers stay valid).
- **Reflash re-mirrors all of src/:** when `doUploadSingleFile` detects a
  C-module change (`isCModulesConfigChanged`), it no longer uploads just the one
  saved file — flashing wipes the device filesystem, so it delegates to a full
  `mirrorSrcToDevice({ changedOnly: false })` (build + flash + re-upload every
  src/ file and Lua module).

### 9.2 Bug fix: Device UUID clobbering

**Root cause:** `updateSyncTimestamp(cfg)` received a stale `cfg` captured before
`ensureKnownDevice` replaced `cachedConfig` with the device UUID. When it called
`saveConfig`, it overwrote the just-written UUID on disk.

**Fix (2026-06-08):** `updateSyncTimestamp()` no longer takes a `cfg` parameter.
It re-reads `cachedConfig` via `getConfigOrNull()` instead of using the
caller-supplied reference. All callers (`mirrorSrcToDevice`, `doUploadSingleFile`,
`handleFileDelete`) were updated to call `updateSyncTimestamp()` without args.
Also `scheduleSrcSync` was fixed to pass `currentCfg` (fresh) instead of `cfg`
(stale outer closure) to `doUploadSingleFile`.

### 9.2b Bug fixes (2026-06-11): serial wedge + duplicate first-sync mirror

Found via the hardware e2e suite. Four related fixes:

1. **`SerialSession.runExclusive` gate leak** (`src/serial/serialSession.ts`):
   if `open()` threw (port busy), the exclusive gate was never released and
   every later serial operation on the session awaited it forever. `open()` is
   now inside the try whose finally releases the gate.
2. **`SerialSession.open()` timeout**: the native `port.open` callback can fail
   to fire after rapid open/close contention; a 10 s deadline now converts that
   into an error instead of a permanent hang (which wedged the CommandQueue).
3. **Nested duplicate mirror**: `doFlash` runs a full `mirrorSrcToDevice`
   (force-format) after flashing a newly claimed device. When the flash was
   itself triggered from inside `mirrorSrcToDevice`'s firmware check, the
   device got formatted and synced twice and a misleading early "synced" toast
   fired mid-run. Sync-internal callers now use `buildAndFlashForSync()` /
   `flashFirmware(signal, { postFlashSync: false })`; the outer mirror re-reads
   the config after a flash (the pre-flash device claim rewrites the ini) and
   formats once via `flashedDuringCheck && isFreshWorkspace`.
4. **Silent sync failures**: `scheduleSrcSyncUri` `void`-ed the enqueue promise,
   so a thrown sync (e.g. `switchPort` failing) vanished and the status bar
   stuck at "preparing sync...". Rejections are now logged, toasted, and the
   status set to error; mirror abort paths also reset the status.
5. **Stale-config clobber, round 2** (same class as §9.2): `ensureKnownDevice`
   saved the caller's cfg snapshot when adding the device UUID. Initialize
   Project kicks off the first sync immediately, so a module toggled while the
   identity read was in flight got wiped from `nodemcu.ini` when the claim
   landed. It (and `ensurePort`'s auto-port write) now re-read the live config
   at write time. Rule of thumb: **never `saveConfig` a cfg object you've held
   across an `await`** — merge into `getConfigOrNull()` at the moment of
   writing.
6. **Stale firmware flashed after a C-module change**: the firmware is a CMake
   superbuild — the real compile is an ExternalProject whose build step is
   gated by stamp files (`build/firmware-prefix/src/firmware-stamp/firmware-build`,
   `firmware-done`, `build/CMakeFiles/firmware-complete`). A `user_modules.h`
   rewrite does not invalidate those stamps, so the outer ninja can report
   "no work to do" and the subsequent flash writes the previous binaries
   (observed: coap enabled, header updated, device still boots without coap).
   `BuildManager.build` now deletes the stamps whenever the module selection
   changed; the inner build is dependency-tracked so it stays incremental.

### 9.3 Serial console and output focus

The bottom-panel **NodeMCU Serial** console is the default live feedback surface.
It auto-opens/connects for a valid project unless the user explicitly runs
**Disconnect Serial Session** or **Release Serial Port**. Normal serial
operations focus/connect it and keep the shared serial session alive; only the
console input box is disabled while an exclusive upload/list/delete/run/reset
operation is active.

The regular **NodeMCU** output channel is now a quiet log sink. It still receives
timestamped extension logs but must not call `outputChannel.show(true)` from
normal command/sync flows because that steals focus from the Serial Console.

### 9.4 Known issues

(2026-06-11: previous entries here are fixed — the Lua/C Modules views populate
and round-trip checkbox state against a real EDH, and the
`nodemcu-vscode.firmwarePath` default is now `""`. Verified by the hardware
e2e suite, scenario 2.)

- The hardware e2e suite (`tests/e2e/device_cdp_e2e.test.ts`) reads device
  serial output directly. The extension's shared serial session owns the port,
  so every direct read must be wrapped in `withSerialReleased()` (runs
  **NodeMCU: Release Serial Port** before and **Reconnect Serial Port** after).
  A bare `new SerialPort(...)` gets "Access denied" otherwise.

### 9.5 Things to verify before "fixing" anything

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

### 9.6 Firmware policy (do not regress)

- `firmware_path` empty → use managed firmware (download `mbedtls-2.28.10-beta`).
- The literal string `../nodemcu-firmware` from older configs is **legacy noise**
  and should be silently treated as empty (see
  `src/extension.ts:170` `LEGACY_DEFAULT_FIRMWARE_PATH`).
- Only honor a non-empty `firmware_path` when the user has clearly set it.

### 9.8 CDP/e2e testing rule (MANDATORY)

Before writing or modifying any CDP-driven e2e test (`tests/e2e/*.test.ts`),
**always** first prove the UI path interactively with small manual CDP probes
against a running Extension Development Host. Use `node` scripts that evaluate
simple JS expressions, click elements, and inspect state. Only after the manual
path is fully understood should you encode it into a Vitest e2e suite.

### 9.9 Non-obvious gotchas

- The `resources/templates/nodemcu.ini` still references the legacy
  `../nodemcu-firmware` default.
- `git status` will routinely show `package-lock.json` as dirty because
  `pnpm-lock.yaml` and `bun.lock` are also committed. Don't "fix" this.
- The repo is 14 commits ahead of `origin/main`; the user is iterating locally
  and hasn't pushed. Don't push unless explicitly asked.
- `.claude/SESSIONS/` is gitignored — don't create files there for the project.
  Use proper skills under `.claude/SKILLS/` if you need reusable automation.

---

## 10. SerialDeviceClient device protocol (read before touching uploads)

`SerialDeviceClient` (`src/device/serialDeviceClient.ts`) drives the device over
the shared serial session by sending Lua to the REPL. Two NodeMCU constraints —
both verified against a physical ESP8266 (NodeMCU 3.0.0, float build) — shape
every command it emits. Violating either fails **silently**:

1. **REPL input line limit ≈ 256 bytes.** A command line longer than that is
   silently truncated and fails to parse, so the intended effect never happens
   (e.g. a `uart.on` handler is never registered, or a read command produces no
   output). Keep every line well under 256: define helpers/handlers in small
   pieces (`HEX_OF_STRING_DEF`, `__dump`, the windowed-upload `_G.u*` setup)
   rather than one giant statement. The old single-line download (359 chars) and
   the first cut of the streaming upload (315 chars) both failed this way.
2. **`tostring(<number>)` is broken on some builds** (returns `"g"`). Use
   `string.format("%d", n)` / `%02x` instead. This is why `listFiles` sizes used
   to come back as `0`.

### 10.1 Streaming upload (`uploadContent` → `streamToTempFile`)

Replaces the old "hex string, one `__vscode_hex(...)` REPL command per ~116
bytes" loop. Now: open a temp file, arm a `uart.on("data",0,fn,0)` handler
(`run_input=0` ⇒ received bytes are written verbatim, never echoed or
interpreted ⇒ **binary-safe**), then send the raw file bytes. Termination is by
exact byte count (`un>=uL`), not an in-band marker, so a payload may contain any
byte sequence. On the last byte the handler unregisters itself and prints a
unique done marker.

**Flow control is mandatory.** Blasting the whole file at once overflows the RX
buffer (the Lua data callback + `file.write` cannot keep up at 115200) and bytes
are dropped, so the byte count never completes and the upload hangs. We send
fixed `STREAM_WINDOW` (256) byte windows and wait for a per-window ACK from the
device before sending the next — one window in flight at a time. Measured
~0.8 KB/s for tiny files (latency-bound by setup + ACKs) up to ~3.8 KB/s at 8 KB.

### 10.2 Download (`download` → `__dump`)

Streams hex straight to the UART in 64-byte chunks instead of building the whole
hex string in the ~40 KB device heap (which OOMs for files over ~2 KB). The read
loop is a single synchronous Lua statement, and NodeMCU's scheduler is
cooperative, so background timer/network callbacks (e.g. a project `init.lua`
doing HTTP) cannot interleave output into the hex stream.

### 10.3 Verifying upload/download changes on hardware

`SerialDeviceClient` depends only on `vscode.EventEmitter` at runtime. To drive
the **real** class against `/dev/ttyUSB0` without an Extension Development Host,
bundle a small driver with esbuild aliasing `vscode` to a 10-line `EventEmitter`
shim and keeping `serialport` external, then `node` the bundle. Reset first
(`client.reset()`) — a previously aborted upload can leave a `uart.on("data")`
handler armed with `run_input=0`, which swallows all REPL input until a reset.
Validate with a payload containing every byte value 0–255 plus tokens like
`EOF_END` to prove binary-safety; check large files (8 KB+) with a device-side
length+checksum (`string.format`-based) when a full hex readback would be too
slow.
