# NodeMCU VSCode Extension — Agent Guide

## Commands (order matters)

```bash
npm run typecheck    # tsc --noEmit (strict: noUnusedLocals, noUnusedParameters)
npm run build        # esbuild bundles src/extension.ts → dist/extension.js (cjs, node18)
npm run test:unit    # vitest run tests/unit  (73 tests)
npm run test:integration
npm run test:e2e     # requires real hardware
npm test             # runs all three
```

`typecheck` and `build` are independent (esbuild doesn't typecheck). Run both. Lint = typecheck.

## Build & package

- Entrypoint: `src/extension.ts`, bundled into `dist/extension.js`
- `vscode` and native modules like `serialport` MUST be external in esbuild (`external: ["vscode", "serialport"]`)
- To produce VSIX: `npm run build ; npm run typecheck ; npm run package` (uses `npx @vscode/vsce package`)
- `.vscodeignore` MUST NOT ignore `node_modules` or `dist`, otherwise `vsce` will fail to bundle native dependencies like `serialport`, causing silent activation crashes in VSCode!

## Testing quirks
- The Windows path separator tests in `paths.test.ts` naturally fail if using hardcoded forward slashes; use `path.join` for cross-platform compatibility.
- Ensure all automated tasks use `;` instead of `&&` when executed under PowerShell to prevent syntax parsing errors.
- Never manually manipulate `package.json` with regex or blind replacements; always test formatting to prevent `npm` parsing errors that break all commands.

## Agent Skills Index

This repository contains custom Agent Skills under the `.claude/SKILLS` directory to automate testing and validation tasks:

- **[devtools-automation](file:///c:/Users/caioh/src/vscode/nodemcu-vscode/.claude/SKILLS/devtools-automation/SKILL.md)**: Automate and inspect the running VS Code / Electron development host using Chrome DevTools Protocol (CDP) WebSocket connections. Useful for verifying UI components, clicking list checkboxes, and triggering command palette commands.

## Current handoff context

The extension is still failing in the Extension Development Host despite recent attempted fixes:

- **Build & Flash** still reports: `No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first.`
- **Lua Modules** view is empty. It should list all available Lua modules from the NodeMCU firmware `lua_modules` library and allow selecting/toggling by clicking items in the list.
- **C Modules** should behave the same: list available firmware C modules and allow toggling by clicking items.
- **Device Explorer** still only shows `NodeMCU (port)` and does not meaningfully reflect whether a NodeMCU device is actually connected.

Expected firmware behavior:

- The extension should **not require users to clone or configure a firmware path**.
- It should download and manage firmware itself under the VS Code extension global storage directory.
- The required archive is:
  `https://github.com/caiohamamura/nodemcu-firmware/archive/refs/tags/mbedtls-2.28.10-beta.zip`
- Treat an empty `firmware_path` as “use managed firmware.”
- Treat the old default `../nodemcu-firmware` as legacy noise unless the user clearly configured a custom checkout.

Important notes for the next fix attempt:

- Do not assume passing `npm run typecheck` and `npm run build` means the Extension Development Host behavior works.
- The module lists likely need to become resilient even before managed firmware finishes downloading, and should force/await firmware preparation when the views open.
- `nodemcu.ini` discovery is still suspect in the running extension; inspect activation timing, workspace roots, and whether the Extension Development Host is actually using the rebuilt `dist/extension.js`.
- Device Explorer should actively enumerate serial ports and connected-device files instead of showing a static placeholder root.
