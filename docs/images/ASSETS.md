# README media assets — recording checklist

The README references the files below. All were captured 2026-06-11 against a
real ESP8266 on COM7 by driving an Extension Development Host over CDP
(`Page.captureScreenshot` frames assembled with ffmpeg palettegen/paletteuse).

General rules:

- GIFs: 1280 wide, 15–20 s max, slow phases (flash/format/sync) timelapsed.
- Screenshots: PNG, VS Code Dark Modern, no personal paths visible.
- vsce rewrites relative image paths to the repository URL, so assets must be
  committed to the repo (they do not need to ship inside the VSIX —
  `.vscodeignore` excludes `docs/**`).

## Status

| # | File | Type | Content | Status |
| --- | --- | --- | --- | --- |
| 1 | `quick-start.gif` | GIF ⭐⭐⭐⭐⭐ | Hero: empty folder → **Initialize NodeMCU Project** → port auto-select → edit `init.lua` → save → firmware flash → format → sync → serial output. | ✅ recorded |
| 2 | `overview.png` | PNG ⭐⭐⭐⭐⭐ | Full IDE: NodeMCU sidebar + editor + Serial Console with boot banner. | ✅ recorded |
| 3 | `auto-upload.gif` | GIF ⭐⭐⭐⭐⭐ | Edit print → save → `uploading init.lua…` → reset → output in console. | ✅ recorded |
| 4 | `intellisense.gif` | GIF ⭐⭐⭐⭐ | Type `fif` → **NodeMCU Lua module** completion → accept inserts `fifo = require("fifo")`, checks the sidebar box → hover docs on `print`. (The stubs declare module globals only — there is no `wifi.`-member completion, so the GIF shows the module-completion feature instead.) | ✅ recorded |
| 5 | `build-flash.gif` | GIF ⭐⭐⭐ | Check `bme280` C module → **Build & Flash** → build/flash toasts → reboot banner now lists `bme280`. | ✅ recorded |
| 6 | `initialize.gif` | GIF | Activity bar → Initialize → views populate, console connects. | ✅ recorded |
| 7 | `device-explorer.png` | PNG | Device Explorer pane, COM7 selected. | ✅ recorded |
| 8 | `lua-modules.png` | PNG | Lua Modules pane, `fifo` + `gossip` checked. | ✅ recorded |
| 9 | `c-modules.png` | PNG | C Modules pane with enabled modules. | ✅ recorded |
| 10 | `select-port.png` | PNG | `NodeMCU: Select Port` quick pick. | ✅ recorded |
| 11 | `serial-success.png` | PNG | Serial Console: healthy boot banner + print output. | ✅ recorded |
| 12 | `marketplace-banner.png` | PNG | 1280×640 wide banner. | ⬜ not produced (README does not reference it) |

## Re-recording

Capture tooling from the 2026-06-11 session lives outside the repo at
`C:\temp\nodemcu-vscode-gif\tools` (CDP frame recorder, scenario drivers,
ffmpeg concat specs). The approach: launch an EDH with
`--remote-debugging-port=9222` and `NODEMCU_VSCODE_STORAGE_ROOT=~/.nodemcu-vscode`,
record timestamped PNG frames via `Page.captureScreenshot`, drive the UI over
CDP, then assemble per-segment retimed GIFs with ffmpeg concat + palette.
