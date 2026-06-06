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
