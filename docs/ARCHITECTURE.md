# NodeMCU VS Code Extension — Architecture & Function Index

A guide for **human contributors**. Read this to understand how the extension is
put together and to find *where* to make a change and *what* each function does.

This document is self-contained. For agent handoff notes, the current
work-in-progress context, and very deep protocol details, see
[`AGENTS.md`](../AGENTS.md). For end users, see [`README.md`](../README.md).

---

## 1. What this extension is

`nodemcu-vscode` (display name **NodeMCU Lua**) is a VS Code extension for
end-to-end Lua firmware development on NodeMCU / ESP8266 boards. It can:

- **Build** custom firmware (CMake + esptool toolchain).
- **Flash** the firmware to a board over serial.
- **Upload** Lua files to the device filesystem (and auto-sync `src/` on save).
- **Serial console** — a webview REPL/monitor over the active serial session.
- **IntelliSense** — generate Lua API stubs consumed by `sumneko.lua`.
- Manage **C modules** and **Lua modules** through tree-view checkboxes.
- Build and deploy **LFS** (Lua Flash Store) images.

### The one design choice that explains everything

The extension **never asks the user to clone `nodemcu-firmware`**. On first build
it downloads a known-good firmware archive, extracts it, hydrates submodules, and
applies a couple of compatibility patches — all into VS Code's extension global
storage. This lives in [`src/firmware/managedFirmware.ts`](../src/firmware/managedFirmware.ts).

The literal string `../nodemcu-firmware` that appears in `nodemcu.ini` is **legacy
noise** and is treated as empty (`LEGACY_DEFAULT_FIRMWARE_PATH` in `extension.ts`).

### Stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript (ES2022, Node16 module resolution, strict) |
| Bundler | esbuild → `dist/extension.js` (single CJS bundle, node18 target) |
| Entry point | `package.json#main` = `dist/extension.js` (NOT `src/`) |
| Runtime deps | `serialport` (native, `external` in esbuild), `nodemcu-tool` |
| Tests | vitest (single-fork pool, globals, 60 s timeout) |

> VS Code loads the **bundle**. Any source change needs `npm run build` + a window
> reload (or `npm run watch`). Editing `src/` alone changes nothing at runtime.

---

## 2. Big-picture architecture

Three layers, top to bottom:

```
┌──────────────────────────────────────────────────────────────────────┐
│  src/extension.ts  —  THE ORCHESTRATOR (~2330 lines)                    │
│  activate() wires up:                                                   │
│   • command handlers (doBuild, doFlash, doUploadChanges, …)             │
│   • 4 tree views + welcome view + 2 status-bar items                    │
│   • serial console webview, completion providers, config watcher        │
│   • caches: NodemcuConfig, firmware path promise, serial session        │
└───────────────┬───────────────────────────────────────────────────────┘
                │ delegates to
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  MANAGER / STATEFUL CLASSES                                            │
│   BuildManager · FlashManager · NodemcuTool · DirectSerialUploader     │
│   SerialSession · SerialSessionManager · SerialDeviceClient            │
│   CommandQueue · ConfigWatcher · LiveEditFileSystemProvider            │
│   PythonManager · ToolchainLocator · SerialDiscovery                   │
└───────────────┬───────────────────────────────────────────────────────┘
                │ built on
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  PURE HELPERS (no vscode dep, easy to unit-test)                       │
│   config/nodemcuIni · build/userModulesWriter · build/outputParser     │
│   build/toolchain (command builders) · util/shell · util/paths         │
│   luaApi/apiFiles · luaPicker/* · upload/srcMirror · flash/autoPort     │
│   serial/serialBuffer · serial/serialCursor · serial/serialPatterns    │
└──────────────────────────────────────────────────────────────────────┘
```

**Config is the spine.** `nodemcu.ini` is parsed into a `NodemcuConfig` object
(`config/nodemcuIni.ts`). That object is threaded through nearly everything: which
C modules to compile, which Lua modules to upload, flash size, baud rate, LFS size,
SSL settings, device UUIDs. Tree-view checkboxes mutate the config and save it;
`ConfigWatcher` notices the file change and refreshes the UI.

**The UI surface** (declared in `package.json#contributes`):

- Activity-bar container **NodeMCU** with views: `deviceExplorer`, `projectTasks`
  (welcome when no project), `luaModules`, `cModules`.
- A panel container **NodeMCU Serial** with the `serialConsole` webview.
- ~30 commands, all registered in `activate()`.

---

## 3. End-to-end flows (trace a feature)

### 3.1 Initialize a project
`doInitProject` → writes `nodemcu.ini` (from `resources/templates/nodemcu.ini`) +
`src/init.lua` → starts `ConfigWatcher` → sets `nodemcu.projectValid` context →
Device Explorer / module panels appear.

### 3.2 Build firmware
`doBuild` → `getFirmwarePath()` (lazily calls `ensureManagedFirmware()` the first
time) → `BuildManager.build()`:
1. `writeUserModulesHeader()` regenerates `app/include/user_modules.h` from config.
2. If the C-module selection or Lua flavour changed → `cmakeConfigureCommand` (reconfigure).
3. `cmakeBuildCommand` → build.
4. stdout/stderr → `outputParser.parseProblems()` → VS Code Problems + status bar.

### 3.3 Flash firmware
`doFlash` → `FlashManager.flash()` → `esptoolFlashCommand` (prefers bundled
`tools/toolchains/esptool.py`, falls back to `python -m esptool`). Standard
`0x00000` / `0x10000` offset mapping.

### 3.4 Upload `src/` to the device
`doUploadChanges` (mtime-tracked) / `doUploadFile` → `srcMirror.planMirrorSync()`
computes adds/updates/removes → `SerialDeviceClient` streaming upload over the
shared `SerialSession` (see §4.3). `doUploadAndMonitor` additionally focuses the
serial console and syncs Lua modules.

### 3.5 Serial console
`SerialSessionManager` owns one `SerialSession` per port. `SerialConsoleViewProvider`
renders the webview. Incoming bytes go through `SerialRingBuffer`; `SerialCursor` +
`serialPatterns` detect the Lua prompt / boot banner for command synchronization.

### 3.6 Lua IntelliSense
`moduleList.listLuaModulesFromFirmware()` / `listCModules()` scan the firmware →
`apiFiles.writeLuaRc()` writes `.vscode/nodemcu-api.lua` (`---@meta` stubs) and
`.luarc.json` so `sumneko.lua` picks them up. `LuaModuleCompletionProvider` offers
`require()` completions; accepting one runs `doAcceptLuaModuleCompletion` to enable
+ sync the module.

### 3.7 LFS (Lua Flash Store)
`luac.cross` is sourced either from the build tree or a **prebuilt** binary
(`prebuiltLuacCross.ts`) matching the Lua flavour and host OS. `lfsBuilder.buildLfsImage`
produces the image; `doBuildAndDeployLfs` uploads + reloads it.

### 3.8 Toggle a C / Lua module
Tree checkbox change → `doToggleCModule` / `doAddLuaModule` →
`setCModule` / `setLuaModule` mutate config → `saveConfig` → `userModulesWriter`
regenerates the header → next build reconfigures.

---

## 4. Subsystem deep-dives

### 4.1 Managed firmware (`firmware/managedFirmware.ts`)
`ensureManagedFirmware()` downloads `MANAGED_FIRMWARE_URL` (tag `MANAGED_FIRMWARE_TAG`,
currently `v3.1.1`), extracts it, hydrates three submodules, and writes a
`.nodemcu-vscode-managed-firmware.json` marker so it isn't redone.

### 4.2 LFS & Lua flavour (`firmware/prebuiltLuacCross.ts`)
`luacFlavour(config)` resolves one of `lua51` / `lua51-int` / `lua53`.
`DEFAULT_PREBUILT_RELEASE` carries **two independent tags**:
- `releaseTag` — the GitHub release the asset is downloaded from (e.g. `v3.1.1`).
- `firmwareTag` — the firmware fork tag embedded in the asset filename and used as
  the cache key (e.g. `v3.1.1`).

`resolvePrebuiltLuacCross()` downloads + verifies the right binary for the flavour
and host (`currentPrebuiltTarget()`). Prebuilt assets are produced by the firmware
repo's `luac-cross-release.yml` (`caiohamamura/nodemcu-firmware`), not by this
extension.

### 4.3 Serial device protocol (`device/serialDeviceClient.ts`)
`SerialDeviceClient` is the **active** path for upload/download/list/remove/run/format.
It rides the shared `SerialSession` (not its own port). Upload streams content to a
temp file on the device, then renames into place; download uses a `__dump` helper.
`DirectSerialUploader` (`upload/directSerialUploader.ts`) is now only a fallback /
test transport. `validateRemoteName()` guards against path traversal in device
filenames.

### 4.4 Command queue (`util/commandQueue.ts`)
`CommandQueue` is a FIFO with cancel support that serializes device operations so
two commands never fight over the serial port. `extension.ts` wraps command
handlers via `commandWithOperation(...)`.

### 4.5 Config-change propagation (`config/configWatcher.ts`)
`ConfigWatcher` uses `fs.watch` + a 200 ms debounce and swallows parse errors
silently (a half-saved ini shouldn't crash the UI).

---

## 5. Function index by file

Tables list the **exported** symbols (plus key private methods worth knowing).
Kind: `fn` = function, `cls` = class, `if` = interface, `const` = constant,
`type` = type alias.

### 5.0 `src/extension.ts` — the orchestrator (~2330 lines)

Owns command registration, all tree providers, status bar, config cache, the
managed-firmware promise, port selection, and Lua API regeneration.

| Symbol | Kind | What it does |
| --- | --- | --- |
| `AsyncTreeProvider` | cls | Generic `TreeDataProvider` with a debounced async loader; base for every tree view. |
| `TreeItemNode` | if | Shape of a tree node (label, command, contextValue, payload like `serialPort`/`module`). |
| `LuaModuleCompletionProvider` | cls | `require()` completion provider for Lua files. |
| `activate(context)` | fn | Entry point. Registers commands, views, providers, status bar, watcher. |
| `deactivate()` | fn | Tears down serial sessions on shutdown. |
| `closeSerialMonitors()` / `restoreSerialMonitors()` | fn | Close/reopen serial consoles around a flash (port must be free to flash). |
| `doInitProject()` | fn | Scaffold `nodemcu.ini` + `src/init.lua`; start watcher. |
| `doBuild` / `doFlash` / `doBuildAndFlash` | fn | Core build/flash command handlers. |
| `doUploadFile` / `doUploadChanges` / `doUploadSingleFile` | fn | `src/`-driven and mtime-tracked uploads. |
| `doUploadAndMonitor` | fn | Focus console, upload changes, sync Lua modules (the `Ctrl+S` flow). |
| `doRunFile` / `doResetDevice` | fn | Run a remote Lua file; soft/hard reset the board. |
| `doEnableLfs` / `doDisableLfs` / `doBuildAndDeployLfs` | fn | LFS lifecycle handlers. |
| `doSyncLuaModules` | fn | Compile `[lua_modules]` entries to `.lc` and upload. |
| `doRegenerateLuaApi` | fn | Rewrite `.vscode/nodemcu-api.lua` + `.luarc.json`. |
| `doAddLuaModule` / `doToggleLuaModule` / `doToggleCModule` | fn | Tree-view checkbox actions → mutate + save config. |
| `doAcceptLuaModuleCompletion` | fn | Payload run when a `require()` completion is accepted. |
| `doSelectPort` / `doRefreshExplorer` / `doOpenIni` | fn | Port picker; refresh views; open the ini. |
| `doOpenSerialMonitor` / `doDisconnectSerialSession` / `doReleaseSerialPort` / `doReconnectSerialPort` | fn | Serial console lifecycle. |
| `buildDeviceExplorerProvider` | fn | Lists detected serial ports, click-to-select. |
| `buildLuaModulesProvider` | fn | Lists firmware `lua_modules/`, checkboxes bound to `cfg.lua_modules`. |
| `buildCModulesProvider` | fn | Lists core/optional/library C modules, checkboxes bound to `cfg.c_modules`. |
| `buildProjectTasksProvider` | fn | Welcome/tasks view shown when no valid project. |

### 5.1 `src/config/` — the ini (source of truth)

**`nodemcuIni.ts`**
| Symbol | Kind | What it does |
| --- | --- | --- |
| `NodemcuConfig`, `NodemcuSection`, `LuaModuleEntry`, `SyncSection`, `FlashExtraFile` | if | Config object + section shapes. |
| `DEFAULT_SSL_BUFFER_SIZE`, `TLS_ENABLE_SSL_BUFFER_SIZE`, `DEFAULT_LFS_SIZE` | const | Defaults. |
| `defaultConfig()` | fn | Fresh config with sane defaults. |
| `parseIni(content)` / `serializeIni(config)` | fn | ini text ⇄ `NodemcuConfig`. |
| `loadConfig(path)` / `saveConfig(path, config)` | fn | Disk I/O wrappers. |
| `setCModule` / `setLuaModule` | fn | Toggle a module, return new config. |
| `getLuaModuleEntries(config)` | fn | Normalized list of `[lua_modules]` entries. |
| `hasDeviceUuid` / `addDeviceUuid` | fn | Track per-device UUIDs. |
| `isLfsEnabled(config)` | fn | Whether LFS is on. |

**`configWatcher.ts`** — `ConfigWatcher` (cls): fs.watch + 200 ms debounce.
**`iniCompletion.ts`** — `IniCompletionItemProvider` (cls): autocomplete inside `nodemcu.ini`.

### 5.2 `src/build/` — the build pipeline

**`buildManager.ts`** — `BuildManager` (cls): orchestrates `build(ctx)` (header
regen → maybe reconfigure → cmake build → parse). `BuildContext` / `BuildResult` (if).
Private `luaFlavourChanged`, `binPaths`.

**`toolchain.ts`**
| Symbol | Kind | What it does |
| --- | --- | --- |
| `ToolchainInfo` | if | Detected generator + tool paths. |
| `detectHostCompiler(shell)` | fn | Find a host C compiler. |
| `ToolchainLocator` | cls | Detect Ninja > MSYS Make > NMake > MinGW > Unix Make. |
| `cmakeConfigureCommand` / `cmakeBuildCommand` | fn | Build the cmake command specs. |
| `esptoolFlashCommand` | fn | Build the esptool flash command spec. |
| `normalizeFlashSize(value)` | fn | `4M` → `4MB`, etc. |

**`userModulesWriter.ts`**
| Symbol | Kind | What it does |
| --- | --- | --- |
| `MODULE_DEPENDENCIES` | const | Force-enable deps (e.g. `tls` → `http`). |
| `MANDATORY_C_MODULES` | const | Always-compiled core modules. |
| `generateUserModulesHeader(config)` / `writeUserModulesHeader(path, config)` | fn | Emit `LUA_USE_MODULES_<NAME>` defines into `user_modules.h`. |
| `readSelectedModules` / `diffSelectedModules` | fn | Read back + diff selections (drives reconfigure). |
| `isCModulesConfigChanged` | fn | Did the C-module set change vs the header on disk? |
| `isTlsEnabled` | fn | Is the `tls` module on? |
| `setUserConfigSsl` / `writeUserConfigSsl` | fn | Toggle `CLIENT_SSL_ENABLE` / `SSL_BUFFER_SIZE` in `user_config.h`. |
| `setUserConfigLfs` / `writeUserConfigLfs` | fn | Set LFS size in `user_config.h`. |
| `setUserConfigBitRate` / `writeUserConfigBitRate` | fn | Sync default baud into the header. |

**`outputParser.ts`** — `parseProblems(output)` → `CompileProblem[]` (GCC + CMake
regex), `summarize(problems)`, `extractModuleBuildSummary(output)` (built/skipped/failed
per module). Pure, no vscode dep.

**`lfsBuilder.ts`** — `lfsImageCommand(opts)` (build the `luac.cross` command spec),
`buildLfsImage(shell, opts)` → `LfsImageResult`.

### 5.3 `src/firmware/` — managed firmware & prebuilt luac

**`managedFirmware.ts`** — `ensureManagedFirmware(opts)` (download/extract/patch),
`MANAGED_FIRMWARE_TAG`, `MANAGED_FIRMWARE_URL`.

**`prebuiltLuacCross.ts`**
| Symbol | Kind | What it does |
| --- | --- | --- |
| `LuacFlavour` (`lua51`/`lua51-int`/`lua53`) | type | Lua build flavour. |
| `luacFlavour(config)` / `luacFlavourInfo(flavour)` | fn | Resolve flavour + its metadata. |
| `currentPrebuiltTarget()` | fn | Host OS/arch target. |
| `DEFAULT_PREBUILT_RELEASE` | const | `releaseTag` + `firmwareTag` (see §4.2). |
| `prebuiltAssetName(target, flavour, firmwareTag)` | fn | Asset filename. |
| `prebuiltCachePath(...)` | fn | Where the binary is cached. |
| `resolvePrebuiltLuacCross(...)` / `installPrebuiltLuacCross(...)` | fn | Fetch + verify + install. |

### 5.4 `src/flash/` — port selection & flashing

**`flashManager.ts`** — `FlashManager` (cls), `FlashContext`/`FlashResult` (if).
**`serialDiscovery.ts`** — `SerialDiscovery` (cls): list ports via `serialport`,
PowerShell on Windows, `/dev/tty*` glob on Linux; honors `NODEMCU_VSCODE_FAKE_SERIAL_PORTS`.
`serialPortDisplayName(port)`, `SerialPort` (if).
**`autoPort.ts`** — `chooseAutoPort(...)` (pure auto-select policy), `isNodeMcuLikePort(port)`,
`AutoPortSelection` (if).

### 5.5 `src/serial/` — serial session & console

| File | Symbol | What it does |
| --- | --- | --- |
| `serialSession.ts` | `SerialSession` (cls) | One open port: `open`/`close`/`write`/`sendCommand`/`waitFor`/`reset`/`createCursor`/`snapshot`. State machine + line/device-event emission. |
| `serialSessionManager.ts` | `SerialSessionManager` (cls) | Owns sessions per port; hands them out. |
| `serialConsoleView.ts` | `SerialConsoleViewProvider` (cls) | The webview REPL/monitor. |
| `serialBuffer.ts` | `SerialRingBuffer` (cls) | Bounded ring buffer of `SerialChunk`s with sequence numbers. |
| `serialCursor.ts` | `SerialCursor` (cls) | Cursor over the buffer; `waitFor` / `waitForAny` a pattern. |
| `serialPatterns.ts` | `SERIAL_PATTERNS`, `waitForLuaPrompt`, `waitForBoot` | Regexes + helpers for the Lua prompt / boot banner. |

### 5.6 `src/device/` — device client & live edit

| File | Symbol | What it does |
| --- | --- | --- |
| `serialDeviceClient.ts` | `SerialDeviceClient` (cls) | Active upload/download/list/remove/run/mkfs/reset over a `SerialSession`. |
| `liveEditFs.ts` | `LiveEditFileSystemProvider`, `LIVE_EDIT_SCHEME` (`nodemcu-live`) | In-memory FS so device files open as editable docs; save → upload. |
| `deviceIdentity.ts` | `readDeviceIdentity`, `parseMacAddress`, `normalizeMacAddress` | Read/parse the board MAC → identity. |
| `deviceFirmwareInfo.ts` | `readDeviceFirmwareInfo` | Read firmware version/flavour from the device. |

### 5.7 `src/upload/` — upload transports & mirroring

| File | Symbol | What it does |
| --- | --- | --- |
| `srcMirror.ts` | `getFilesRecursively`, `localFilesForSrc`, `planMirrorSync` | Compute the add/update/remove plan to mirror `src/` onto the device. |
| `directSerialUploader.ts` | `DirectSerialUploader`, `SerialPortTransport`, `validateRemoteName` | Fallback/test serial upload transport + remote-name guard. |
| `nodemcuTool.ts` | `NodemcuTool` | Wraps `node bin/nodemcu-tool.js` (upload/download/remove/fsinfo); honors `NODEMCU_VSCODE_NODEMCU_TOOL`. |

### 5.8 `src/luaApi/` & `src/luaPicker/` — IntelliSense & module pickers

**`luaApi/apiFiles.ts`** — `generateLuaApiFile(opts)` (`---@meta` stubs for ~30
modules), `generateLuaRc(opts)`, `writeLuaRc(opts)` (writes both files).

**`luaPicker/moduleList.ts`** — `listLuaModulesFromFirmware`, `listLuaModulesFromDir`,
`listCModules`, `selectMainFileForConfig`; `LuaModuleInfo`/`CModuleInfo` (if).
Note: `LuaModuleInfo.name` is the **main file's basename** (require name), `dirName`
is the firmware folder — they can differ.
**`luaPicker/luaModuleResolver.ts`** — `resolveLuaModule`, `resolveAllLuaModules`,
`validateLuaModuleSource` (rejects `..` and bad URLs). Search order: absolute →
`workspaceRoot/<source>` → `firmware/lua_modules/<name>/<basename>` → `firmware/lua_modules/<source>`.
**`luaPicker/luaModuleCompletion.ts`** — `createLuaModuleCompletionItem`,
`luaModuleRequireText`, `luaModuleSource` (build the completion + accept payload).

### 5.9 `src/util/`, `src/tools/`, `src/python/`, `src/status/`

| File | Symbol | What it does |
| --- | --- | --- |
| `util/shell.ts` | `Shell` (cls), `quoteArg`, `formatCommand`, `CommandSpec` (if) | `spawn` wrapper with `onStdout`/`onStderr`, `windowsHide`, cross-platform `which`. |
| `util/paths.ts` | `resolveFirmwarePath`, `defaultBuildDir`, `userModulesHeader`, `userConfigHeader`, `esptoolScript`, `luaModulesDir`, `appModulesDir`, `binOutput`, `luacCrossPath`, `lfsImagePath`, `cModuleNameFromFile`, `isOptionalCModule`, `toolchainBinDirs` | Pure firmware-relative path helpers. |
| `util/commandQueue.ts` | `CommandQueue` (cls) | FIFO device-op queue with cancel; emits state. |
| `tools/managedTools.ts` | `ensureCMake`, `ensureNinja`, `ensureManagedPython` | Download/locate build tools on demand. |
| `python/pythonManager.ts` | `PythonManager` (cls) | Locate/manage a Python interpreter for esptool. |
| `status/statusBar.ts` | `StatusEmitter` (cls), `BuildState` (type) | Drives status-bar state (`idle`/`configuring`/`building`/`flashing`/`uploading`/`success`/`error`). |
| `types/ini.d.ts` | — | Ambient module declaration for the `ini` package. |

---

## 6. "Where do I change X?" — task map

| I want to… | Touch these files |
| --- | --- |
| Add / rename a command | `package.json` (`contributes.commands` + `activationEvents`), `activate()` registration, and a `doX` handler in `src/extension.ts`. |
| Change ini schema / defaults | `src/config/nodemcuIni.ts` and `resources/templates/nodemcu.ini`. |
| Change build flags / generator detection | `src/build/toolchain.ts`, `src/build/buildManager.ts`. |
| Change the C-module list / dependencies | `src/build/userModulesWriter.ts` (`MODULE_DEPENDENCIES`, `MANDATORY_C_MODULES`), `src/luaPicker/moduleList.ts` (optional/library lists). |
| Change generated Lua API stubs | `src/luaApi/apiFiles.ts` (`KNOWN_GLOBALS`). |
| Change serial / REPL behavior | `src/serial/*`, `src/device/serialDeviceClient.ts`. |
| Bump firmware version or patches | `src/firmware/managedFirmware.ts`, `src/firmware/prebuiltLuacCross.ts`. |
| Change upload logic | `src/upload/srcMirror.ts`, `src/device/serialDeviceClient.ts`. |
| Change flashing | `src/flash/flashManager.ts`, `src/build/toolchain.ts` (`esptoolFlashCommand`). |
| Change port discovery / auto-select | `src/flash/serialDiscovery.ts`, `src/flash/autoPort.ts`. |
| Change the tree views / panels | `package.json` (`contributes.views`/`viewsWelcome`) + the `buildXProvider` fns in `src/extension.ts`. |

---

## 7. Build, test, package

```bash
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → dist/extension.js
npm test            # vitest: unit + integration
npm run watch       # rebuild on change (still needs window reload)
```

- **Tests**: `tests/unit/` (~20 files, no I/O outside tmp) and `tests/integration/`
  (fakes the shell — `managers.test.ts`, `configWatcher.test.ts`, `moduleList.test.ts`).
  Test-only env vars: `NODEMCU_VSCODE_FAKE_SERIAL_PORTS`, `NODEMCU_VSCODE_NODEMCU_TOOL`.
- **VSIX gotchas** (read before `npm run package`):
  - `.vscodeignore` **must keep** `node_modules/` and `dist/`, or the native
    `serialport` binding silently won't ship.
  - `serialport` stays `external` in `esbuild.config.mjs` — never bundle it.
- **Host note**: the maintainer's dev host is Windows / PowerShell 7+ — chain shell
  commands with `;`, not `&&`.

---

## 8. See also

- [`AGENTS.md`](../AGENTS.md) — agent handoff, current WIP context, the serial
  upload protocol in full (§10), release process (§6.4), debugging recipes.
- [`README.md`](../README.md) — user-facing features and quick start.
- [`.claude/SKILLS/README.md`](../.claude/SKILLS/README.md) — the
  `devtools-automation` skill (CDP-driven UI validation).
