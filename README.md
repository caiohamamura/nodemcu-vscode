# NodeMCU VSCode

A VSCode extension for cross-platform NodeMCU/ESP8266 Lua firmware development.

## Features

- **Build firmware** — downloads and manages the NodeMCU firmware source, then runs CMake/ninja/make
- **Flash firmware** — invokes the bundled `esptool.py`
- **Upload Lua files** to the device via `nodemcu-tool` (auto-installs if missing)
- **Sync Lua modules** declared in `nodemcu.ini` to the device
- **Device Explorer** sidebar — browse files on the connected NodeMCU
- **Lua module picker** — list all modules in the managed firmware `lua_modules/` and add to project
- **C module picker** — toggle which C modules get compiled into the firmware
- **Lua API stub generator** — produces `.vscode/nodemcu-api.lua` and `.luarc.json` for full intellisense via the `sumneko.lua` extension
- **Cross-platform** — works on Linux, macOS, and Windows

## Quick start

1. Install the **Lua** extension (`sumneko.lua`) — required for language server support.
2. Open your project folder in VSCode.
3. Run **NodeMCU: Initialize Project** from the command palette.
4. Edit `nodemcu.ini` — set `port` if needed and toggle `[c_modules]`.
5. Run **NodeMCU: Build & Flash** (`Ctrl+Alt+B`). The extension downloads and reuses its managed firmware copy automatically.

## Configuration

The plugin reads `nodemcu.ini` (format inspired by `platformio.ini`).

```ini
[nodemcu]
firmware_path =
lua_version = 53
port = /dev/ttyUSB0
baud = 115200
flash_mode = dio
flash_freq = 40m
flash_size = 1M

[c_modules]
adc = true
wifi = true
node = true
; coap = false

[lua_modules]
bh1750 = lua/bh1750.lua
file_lfs = lua/file_lfs.lua
```

Leave `firmware_path` empty to use the extension-managed firmware downloaded from `mbedtls-2.28.10-beta`. Set it only when deliberately using a custom local checkout.

## Commands

| Command | Description |
|---|---|
| `NodeMCU: Initialize Project` | Create a default `nodemcu.ini` |
| `NodeMCU: Build Firmware` | Run CMake configure + build |
| `NodeMCU: Flash Firmware` | Run `esptool.py write_flash` |
| `NodeMCU: Build & Flash` | Build then flash |
| `NodeMCU: Upload File to Device` | Upload a `.lua` or `.lc` file via `nodemcu-tool` |
| `NodeMCU: Sync Lua Modules to Device` | Upload all `[lua_modules]` entries, pre-compiling them |
| `NodeMCU: Toggle C Module` | Enable/disable a C module in the firmware |
| `NodeMCU: Add Lua Module from Library` | Add a module from `firmware/lua_modules/` to your project |
| `NodeMCU: Regenerate Lua API Stubs` | Generate `.vscode/nodemcu-api.lua` and `.luarc.json` |

## Development

```bash
npm install
npm run build       # produce dist/extension.js
npm test            # run unit + integration + e2e tests
npm run watch       # rebuild on change
```

Press F5 in VSCode to launch an Extension Development Host for manual testing.
