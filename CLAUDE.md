# CLAUDE.md

A short pointer for Claude Code. The full agent guide (build, test, source map,
env vars, handoff context) lives in **[AGENTS.md](AGENTS.md)** — read that first.

## TL;DR

- **Project**: VS Code extension `nodemcu-vscode` (display name "NodeMCU") for
  end-to-end Lua firmware development on NodeMCU / ESP8266. Builds, flashes,
  uploads Lua files, generates Lua API stubs for `sumneko.lua`.
- **Stack**: TypeScript (ES2022 / Node16 / strict), esbuild → `dist/extension.js`
  (CJS, node18), vitest for tests, `serialport` + `nodemcu-tool` at runtime.
- **Key design choice**: the extension does **not** require users to clone
  `nodemcu-firmware`. It downloads and patches a known-good archive
  (`mbedtls-2.28.10-beta`) on first use into the VS Code extension global
  storage. The literal string `../nodemcu-firmware` in `nodemcu.ini` is
  legacy noise and is treated as empty.

## Build & test (run both)

```bash
npm run typecheck    # tsc --noEmit
npm run build        # esbuild bundles src/extension.ts → dist/extension.js
npm test             # unit + integration + e2e
```

VS Code loads `dist/extension.js` (see `package.json#main`). Any change requires
rebuild + window reload (or `npm run watch`).

## Skills

This repo has custom Agent Skills under `.claude/SKILLS/`. See
[`.claude/SKILLS/README.md`](.claude/SKILLS/README.md) for the index.

- **`devtools-automation`** — drive a running Extension Development Host via
  Chrome DevTools Protocol to verify tree-view state, toggle modules, and run
  command palette commands. **This is the primary way to validate the UI**.

## Things to know before "fixing" anything

1. The host is Windows / PowerShell 7+ — use `;` not `&&` to chain commands.
2. `.vscodeignore` must keep `node_modules/` and `dist/` or the VSIX will
   silently lack the native `serialport` binding.
3. `serialport` is `external` in esbuild; never bundle it.
4. The handoff context (what's broken right now) is in **AGENTS.md §9** —
   read it before changing `src/extension.ts`.
5. The CDP e2e test (`tests/e2e/cdp_e2e.test.ts`) is the contract that proves
   the runtime works. Run it after any change to activation flow.
