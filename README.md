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
- **Sync Lua modules** declared in `nodemcu.ini` to the device.
- **Device Explorer** sidebar — enumerate serial ports and browse files on the
  connected NodeMCU (`nodemcu-tool fsinfo --json`).
- **Lua module picker** — list all modules in the managed firmware `lua_modules/`
  and add to project with a click.
- **C module picker** — toggle which C modules get compiled into the firmware.
- **Lua API stub generator** — produces `.vscode/nodemcu-api.lua` and
  `.luarc.json` for full IntelliSense via the `sumneko.lua` extension.
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
3. Edit `nodemcu.ini` — set `port` if needed and toggle `[c_modules]`.
4. Run **NodeMCU: Build & Flash** (`Ctrl+Alt+B`). The extension downloads and
   reuses its managed firmware copy automatically.

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
baud = 115200
flash_mode = dio
flash_freq = 80m
flash_size = 4MB

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

## Commands

| Command | Keybinding | Description |
| --- | --- | --- |
| `NodeMCU: Initialize Project` |  | Create a default `nodemcu.ini` + `init.lua`. |
| `NodeMCU: Build Firmware` | `Ctrl+Shift+B` | Run CMake configure + build. |
| `NodeMCU: Flash Firmware` |  | Run `esptool.py write_flash`. |
| `NodeMCU: Build & Flash` | `Ctrl+Alt+B` | Build then flash. |
| `NodeMCU: Upload File to Device` |  | Upload a `.lua` or `.lc` file via `nodemcu-tool`. |
| `NodeMCU: Upload Changes to Device` |  | Upload only files in `src/` whose mtime is newer than the last upload. |
| `NodeMCU: Download File from Device` |  | Save a file from the device via `nodemcu-tool`. |
| `NodeMCU: Delete File on Device` |  | Remove a file from the device. |
| `NodeMCU: Refresh Device Explorer` |  | Re-enumerate serial ports and on-device files. |
| `NodeMCU: Sync Lua Modules to Device` |  | Upload all `[lua_modules]` entries, pre-compiling them. |
| `NodeMCU: Toggle C Module` |  | Enable/disable a C module in the firmware (also available in the C Modules view). |
| `NodeMCU: Add Lua Module from Library` |  | Add a module from `firmware/lua_modules/` to your project. |
| `NodeMCU: Regenerate Lua API Stubs` |  | Generate `.vscode/nodemcu-api.lua` and `.luarc.json`. |
| `NodeMCU: Open nodemcu.ini` |  | Reveal `nodemcu.ini` in the editor. |
| `NodeMCU: Open Serial Monitor` |  | Open a `python -c serial.Serial` REPL for the configured port. |
| `NodeMCU: Select Port` |  | Pick from detected serial ports and persist to `nodemcu.ini`. |

---

## Architecture (1-minute tour)

- `src/extension.ts` is the brain: `activate()`, command handlers, three tree-view
  providers (Device Explorer, Lua Modules, C Modules), and the project-tasks pane.
- `src/build/buildManager.ts` is the only thing that runs `cmake` / builds
  firmware; it diffs `app/include/user_modules.h` to decide whether to reconfigure.
- `src/flash/flashManager.ts` runs `esptool.py write_flash` (with a fallback to
  `python -m esptool`) at the standard `0x00000` / `0x10000` offsets.
- `src/upload/nodemcuTool.ts` wraps `nodemcu-tool` for upload / download / remove /
  `fsinfo` (with a JSON parser and a text fallback for older stubs).
- `src/firmware/managedFirmware.ts` is the bootstrap that downloads
  `caiohamamura/nodemcu-firmware` tag `mbedtls-2.28.10-beta`, extracts it,
  hydrates 3 submodules, applies two compatibility patches, and writes a marker
  file so subsequent runs are no-ops.
- `src/luaApi/apiFiles.ts` generates `---@meta` stubs for `sumneko.lua`.
- `src/luaPicker/{moduleList,luaModuleResolver}.ts` powers the Lua/C module
  pickers and resolves local-vs-remote module sources.

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
npm run test:unit          # vitest run tests/unit         (87 tests, ~0.5s)
npm run test:integration   # vitest run tests/integration  (19 tests, ~1.3s)
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
