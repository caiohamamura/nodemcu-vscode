# NodeMCU VSCode

A VS Code extension (`displayName: "NodeMCU"`) for cross-platform Lua firmware
development on **NodeMCU / ESP8266**: build, flash, upload, and explore.

> Looking for the agent / handoff guide? See [AGENTS.md](AGENTS.md). Looking for
> Claude Code specifics? See [CLAUDE.md](CLAUDE.md).

---

## Features

- **Build firmware** — downloads and manages the NodeMCU firmware source
  (`mbedtls-2.28.10-beta`), then runs CMake / Ninja / Make.
- **Flash firmware** — invokes the bundled `esptool.py` (or `python -m esptool`).
- **Upload Lua files** to the device via `nodemcu-tool` (auto-installs if missing).
- **Transactional src/ sync** — saves upload the changed file without scanning
  the whole project. First save performs a full mirror; subsequent saves are
  single-file uploads. Deletions are mirrored to the device.
- **Sync Lua modules** declared in `nodemcu.ini` to the device.
- **Device Explorer** sidebar — enumerate serial ports and auto-select the
  connected NodeMCU when detection is unambiguous.
- **Device Files** sidebar — browse, live edit, run, download, and delete files
  on the connected NodeMCU (`nodemcu-tool fsinfo --json`).
- **Lua module picker** — list all modules in the managed firmware `lua_modules/`
  and add to project with a click.
- **Lua module autocomplete** — typing a firmware Lua module name can insert
  `name = require("name")`, enable it in `nodemcu.ini`, and sync it to the device.
- **C module picker** — toggle which C modules get compiled into the firmware.
- **Upload and Monitor** — `F5` uploads changed files, syncs Lua modules, and
  opens the serial monitor, rebuilding/flashing first if C modules changed.
- **Lua API stub generator** — produces `.vscode/nodemcu-api.lua` and
  `.luarc.json` for full IntelliSense via the `sumneko.lua` extension.
- **Log channel** — every action opens the **NodeMCU** output channel with
  timestamped entries so you can follow what the extension is doing.
- **Cross-platform** — works on Linux, macOS, and Windows.

The extension does **not** require users to clone `nodemcu-firmware`. It
downloads and caches a known-good archive into the VS Code extension global
storage on first use, hydrates required submodules, and applies compatibility
patches. A custom local checkout is only needed when the user deliberately sets
`firmware_path` in `nodemcu.ini` or `nodemcu-vscode.firmwarePath` in settings.

---

## Quick start

1. Open your project folder in VS Code.
2. Run **NodeMCU: Initialize Project** from the command palette.
3. Edit `nodemcu.ini` — toggle `[c_modules]`; `port` is auto-selected when only
   one NodeMCU-like serial device is detected.
4. Run **NodeMCU: Build & Flash** (`Ctrl+Alt+B`). The extension downloads and
   reuses its managed firmware copy automatically.
5. Press **F5** for the normal edit loop: upload changed files, sync Lua modules,
   and open the serial monitor.
6. **Save any file** inside your project's `src/` directory — the extension
   automatically syncs it to the device (full mirror on first save, single-file
   upload thereafter). Follow progress in the **NodeMCU** output channel.

The Lua language extension (`sumneko.lua`) is included in this extension's
`extensionPack` so IntelliSense can use the generated stubs without extra
installs.

---

## Configuration

The plugin reads `nodemcu.ini` (format inspired by `platformio.ini`).

```ini
[nodemcu]
lua_version = 53
port = /dev/ttyUSB0
baud = 460800
flash_mode = dio
flash_freq = 80m
flash_size = 4MB

[devices]
uuids = aabbccddeeff

[sync]
last_timestamp = 2026-06-08T20:33:32.804Z

[c_modules]
adc = true
wifi = true
node = true
; coap = false

[lua_modules]
bh1750 = lua/bh1750.lua
file_lfs = lua/file_lfs.lua
```

Leave `firmware_path` empty to use the extension-managed firmware downloaded
from the `mbedtls-2.28.10-beta` archive. Set it only when deliberately using a
custom local checkout.

The `[sync]` section tracks the last mirror-to-device operation (populated
automatically). When `last_timestamp` is empty, saving a file triggers a full
mirror (format, list remote files, upload/delete as needed). Once populated,
saves only upload the single changed file (or remove the remote file on local
deletion). Clear it to force a full re-sync on the next save.

VS Code settings (`nodemcu-vscode.*`) override / complement the ini:

| Setting | Default | Purpose |
| --- | --- | --- |
| `src` | `"src"` | Directory to watch and auto-upload. |
| `firmwarePath` | `"../nodemcu-firmware"` (legacy) | Override `firmware_path` from settings. Empty string disables the legacy default. |
| `port` | `""` | Serial port (overrides `nodemcu.ini`). |
| `pythonPath` | `"python"` | Python executable for `esptool` and `nodemcu-tool`. |
| `cmakePath` | `"cmake"` | CMake executable. |
| `autoInstallNodemcuTool` | `true` | `npm install nodemcu-tool` if missing. |
| `outputVerbose` | `false` | Show verbose build/flash output. |

---

### Serial port auto-selection

If the configured port is available, the extension keeps it. If it is missing,
or no port is configured, the extension writes a detected port to `nodemcu.ini`
only when the choice is unambiguous: exactly one serial port, or exactly one
NodeMCU-like port among multiple ports. The `nodemcu-vscode.port` setting still
overrides `nodemcu.ini`; clear it to let auto-selection update the project file.

### Device Files live edit

The **Device Files** view lists files from the selected NodeMCU. Click a file to
open an in-memory live-edit document; saving that editor uploads the content back
to the same remote file. Use the context menu or the `Delete` key in the Device
Files view to remove a file from the device.

---

## Commands

| Command | Keybinding | Description |
| --- | --- | --- |
| `NodeMCU: Initialize Project` |  | Create a default `nodemcu.ini` + `init.lua`. |
| `NodeMCU: Build Firmware` | `Ctrl+Shift+B` | Run CMake configure + build. |
| `NodeMCU: Flash Firmware` |  | Run `esptool.py write_flash`. |
| `NodeMCU: Build & Flash` | `Ctrl+Alt+B` | Build then flash. |
| `NodeMCU: Upload File to Device` |  | Upload a `.lua` or `.lc` file via `nodemcu-tool`. |
| `NodeMCU: Upload Changes to Device` |  | Upload only files in `src/` whose mtime is newer than the last upload. |
| (Save file in `src/`) | `Ctrl+S` | Saves trigger automatic sync: full mirror on first save, transactional single-file upload on subsequent saves. File deletions in the workspace are also mirrored. |
| `NodeMCU: Upload and Monitor` | `F5` | Build/flash if C modules are dirty, upload changed files, sync Lua modules, then open the serial monitor. |
| `NodeMCU: Live Edit Device File` |  | Download a device file into an in-memory editor and upload it on save. |
| `NodeMCU: Download File from Device` |  | Save a file from the device via `nodemcu-tool`. |
| `NodeMCU: Delete File on Device` | `Delete` in Device Files | Remove a file from the device. |
| `NodeMCU: Refresh Device Explorer` |  | Re-enumerate serial ports and on-device files. |
| `NodeMCU: Sync Lua Modules to Device` |  | Upload all `[lua_modules]` entries, pre-compiling them. |
| `NodeMCU: Toggle C Module` |  | Enable/disable a C module in the firmware (also available in the C Modules view). |
| `NodeMCU: Add Lua Module from Library` |  | Add a module from `firmware/lua_modules/` to your project. |
| `NodeMCU: Regenerate Lua API Stubs` |  | Generate `.vscode/nodemcu-api.lua` and `.luarc.json`. |
| `NodeMCU: Open nodemcu.ini` |  | Reveal `nodemcu.ini` in the editor. |
| `NodeMCU: Open Serial Monitor` |  | Open `python -m serial.tools.miniterm` for the configured port. |
| `NodeMCU: Select Port` |  | Pick from detected serial ports and persist to `nodemcu.ini`. |

---

## Architecture (1-minute tour)

- `src/extension.ts` is the brain: `activate()`, command handlers, tree-view
  providers (Device Explorer, Device Files, Lua Modules, C Modules), and the
  project-tasks pane.
- `src/build/buildManager.ts` is the only thing that runs `cmake` / builds
  firmware; it diffs `app/include/user_modules.h` to decide whether to reconfigure.
- `src/flash/flashManager.ts` runs `esptool.py write_flash` (with a fallback to
  `python -m esptool`) at the standard `0x00000` / `0x10000` offsets.
- `src/upload/nodemcuTool.ts` wraps `nodemcu-tool` for upload / download / remove /
  live-edit content transfer / `fsinfo` (with a JSON parser and a text fallback
  for older stubs).
- `src/firmware/managedFirmware.ts` is the bootstrap that downloads
  `caiohamamura/nodemcu-firmware` tag `mbedtls-2.28.10-beta`, extracts it,
  hydrates 3 submodules, applies two compatibility patches, and writes a marker
  file so subsequent runs are no-ops.
- `src/luaApi/apiFiles.ts` generates `---@meta` stubs for `sumneko.lua`.
- `src/luaPicker/{moduleList,luaModuleResolver}.ts` powers the Lua/C module
  pickers, Lua-module autocomplete, and local-vs-remote module resolution.
- `src/device/liveEditFs.ts` provides the in-memory `nodemcu-live:` filesystem
  used by Device Files live edit.

### Output channel

Every user action opens the **NodeMCU** output channel (View → Output → NodeMCU)
and logs a timestamped message before starting. Background operations triggered
by saves, file deletions, and checkbox toggles also log their intent. This
replaces silent background work — you always see what the extension is doing.

For a deeper module-by-module map (line numbers, exports, responsibilities), see
[AGENTS.md §4](AGENTS.md#4-source-module-reference).

---

## Development

### Setup

```bash
npm install
npm run build       # produce dist/extension.js
npm run watch       # rebuild on change
```

Press **F5** in VS Code to launch an Extension Development Host for manual
testing. Any code change requires a rebuild + window reload (or `npm run watch`
+ reload).

### Build & package

```bash
npm run typecheck    # tsc --noEmit (strict: noUnusedLocals, noUnusedParameters)
npm run build        # esbuild bundles src/extension.ts → dist/extension.js
npm run package      # npx @vscode/vsce package → .vsix
```

> **Do not edit `.vscodeignore` to ignore `node_modules/` or `dist/`.** `vsce`
> packages them into the VSIX. If they are ignored, the VSIX silently lacks
> the native `serialport` binding and the extension crashes on activation in
> a normal VS Code install.

### Test

```bash
npm run test:unit          # vitest run tests/unit         (165 tests, ~5s)
npm run test:integration   # vitest run tests/integration  (26 tests, ~24s)
npm run test:e2e           # real hardware / real IDE / CDP-driven
npm test                   # runs all three
```

`typecheck` and `build` are independent (esbuild does not typecheck). Run both
before submitting. The `lint` script is just `tsc --noEmit`; lint == typecheck.

Test-only env vars and the CDP-driven e2e harness are documented in
[AGENTS.md §7](AGENTS.md#7-tests).

### Project layout

```
src/                  production code
  build/              build pipeline (cmake / esptool / user_modules.h)
  config/             nodemcu.ini parser + watcher
  firmware/           managed-firmware download/extract/patch
  flash/              esptool invocation + serial port discovery
  luaApi/             sumneko.lua stub generator
  luaPicker/          module list + resolver
  status/             StatusEmitter
  upload/             nodemcu-tool wrapper
  util/               paths + shell helpers
tests/                unit / integration / e2e suites
resources/            icons, snippets, ini template
scripts/              standalone hardware probe
.claude/SKILLS/       custom Agent Skills (see .claude/SKILLS/README.md)
```

---

## License

MIT.
