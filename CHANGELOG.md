# Changelog

All notable changes to the NodeMCU VSCode extension are documented here.

## [0.3.4] - 2026-06-24

### Changed
- **Managed firmware updated from v3.1.1 to v3.1.2.** The extension now
  downloads and caches the `v3.1.2` firmware release. Prebuilt `luac.cross`
  binaries are fetched from the matching release automatically.
- **`buildHostTools` parameter changed from boolean to tristate.** LFS
  configure now passes `BUILD_HOST_TOOLS=AUTO` so host tools build locally
  when a C compiler exists but are silently skipped otherwise (prebuilt binary
  covers the missing-compiler case). Normal firmware builds keep `OFF`.

## [Unreleased]

### Fixed
- **Enabling LFS no longer requires a host C compiler.** The firmware configure
  for LFS passed `-DBUILD_HOST_TOOLS=ON`, which the firmware treats as a hard
  requirement and aborts with `BUILD_HOST_TOOLS=ON requires a host C compiler`.
  It now passes `AUTO`: host tools build locally when a compiler is present and
  are skipped otherwise, with `luac.cross` supplied by the prebuilt download.

### Changed
- **Prebuilt `luac.cross` publishing moved to the firmware repo.** The
  `luac-cross-prebuilt.yml` workflow was removed from this extension; the
  binaries are now built and released by `caiohamamura/nodemcu-firmware`'s
  `luac-cross-release.yml`, keyed by `MANAGED_FIRMWARE_TAG`. Asset names/format
  are unchanged (`prebuiltLuacCross.ts` is the contract).

## [0.3.3] - 2026-06-22

### Fixed
- **LFS commands were hidden from the command palette.** "Enable LFS",
  "Disable LFS", and "Build & Deploy LFS Image" were gated behind a
  `nodemcu.hasHostCompiler` context that required a local C compiler (or a
  successful prebuilt probe at startup). Since `luac.cross` is now always
  fetched as a prebuilt binary from the GitHub release, the gate is removed —
  the LFS commands are available on any valid project (`when:
  nodemcu.projectValid`). The startup compiler probe was dropped.

### Changed
- **Default `nodemcu.ini` values** (new projects + bootstrap template):
  - `lua_version` `53` → `51`
  - `baud` / `upload_baud` `115200` → `460800`
  - `[build] ssl_buffer_size` `16384` → `4096` (matches the firmware-shipped
    default; raise to `8192`/`16384` for large TLS handshakes)

## [0.3.2] - 2026-06-20

### Fixed
- **Boot UART baud now honours `[nodemcu] baud`** — `BuildManager` syncs the
  firmware's `BIT_RATE_DEFAULT` constant in `app/include/user_config.h` with the
  configured baud on every build. Previously the device always booted at the
  firmware default (115200) and ignored the configured rate, which made the
  build/upload baud setting effectively a no-op. Arbitrary baud values
  are snapped to the nearest valid `BIT_RATE_*` constant from the firmware's
  `UartBautRate` enum so an out-of-set value can never name an undefined macro.
  A change to `BIT_RATE_DEFAULT` forces a reconfigure + reflash, like the
  existing SSL/LFS toggles.

## [0.3.1] - 2026-06-19

### Fixed
- **Prebuilt `luac.cross` download** — the resolver was looking for assets at
  `releases/download/<releaseTag>/luac-cross-<releaseTag>-...`, but the assets
  on the v0.3.0 release were named `luac-cross-<firmwareTag>-...` with the
  firmware fork tag (e.g. v3.1.0). The release tag (v0.3.0) and firmware tag
  (v3.1.0) are now properly separated; the resolver downloads from the
  extension's release URL and uses the firmware tag in the asset filename and
  cache key, so the cached binary can never drift from the firmware it builds.
- **CI pipeline** — `npm test` was failing on every push because of the
  resolver bug above, which blocked the VSIX build + publish step. The fix
  restores `npm test` to green.

### Fixed (prebuilt workflow `.github/workflows/luac-cross-prebuilt.yml`)
- Zip directory discovery — the zipball's top-level dir strips the `v`
  prefix, so the workflow now discovers it from the zip listing instead of
  hardcoding `nodemcu-firmware-${FW_TAG}`.
- Dotfiles in the zip wrapper were left behind by `mv "$TOP_DIR"/*` and
  blocked the subsequent `rmdir`; enable `shopt -s dotglob` around the move.
- Windows Configure/Build steps had no `shell: bash`, so PowerShell choked
  on the bash `if [ ... ]` test.
- The `uint` typedef in `app/lua/luac_cross/luac.c` was guarded by
  `defined(_MSC_VER) || defined(__MINGW32__)` only, breaking GCC/Clang
  builds of the lua51 flavours. Expanded to also cover `__GNUC__` and
  `__clang__`.
- PowerShell `Compress-Archive` was given a POSIX-style `/tmp/...` path
  from Git Bash `mktemp`; converted via `cygpath -w` and passed through
  env vars.
- Windows lua51-int matrix entry used `binary: luac.cross.exe`; the cmake
  target for `LUA_NUMBER_INTEGRAL=ON` is `luac.cross.int`, so the produced
  binary is `luac.cross.int.exe`. Corrected.
- Build step used `matrix.binary` to pick the cmake target; switched to
  `matrix.flavour` since `binary` is the filename and the cmake target
  name differs from it on Windows.
- Dropped the `macos-13` (retired) and `macos-14` (deprecating) runners;
  `darwin-arm64` builds now run on `macos-15`.

## [0.3.0] - 2026-06-19

### Added
- **Prebuilt `luac.cross` binaries** — LFS image building now works without a host C compiler on Windows, macOS, and Linux. Binaries are downloaded on demand from the extension release and cached in global storage.
- **Lua flavour support** — distinguish between `lua51`, `lua51-int` (integer numbers), and `lua53`. Each has its own prebuilt binary so the compiler always matches the firmware bytecode.
- **CI workflow** (`.github/workflows/luac-cross-prebuilt.yml`) — builds and publishes prebuilt `luac.cross` for all platforms/architectures. Run `workflow_dispatch` with the firmware tag to generate the assets.
- **Hardware test** (`lfs_heap_e2e.test.ts`) — quantifies LFS RAM savings vs SPIFFS on a real ESP8266.

### Changed
- **LFS prebuilt downloader** — replaced the inline raw-binary downloader with a dedicated module (`src/firmware/prebuiltLuacCross.ts`). More robust: extracts archives, verifies the binary version, and distinguishes Lua flavours.
- **Firmware CMakeLists patch** — forwarded `-DLUA`, `-DLUA_NUMBER_INTEGRAL`, `-DLUA_NUMBER_64BITS` to the firmware ExternalProject so the firmware and `luac.cross` use the same Lua bytecode format (fixes the "LFS image rejected by device" error when flavours mismatch).

### Removed
- Old path helpers `prebuiltLuacCrossDir` / `prebuiltLuacCrossPath` (replaced by the new module).

## [0.2.6] - 2026-06-19

### Fixed
- Serial port wedge after failed uploads (robust post-flash boot wait).
- Stale config clobber (re-read config on each operation).
- Stale firmware flash (detect mismatched firmware versions).

### Improved
- Serial port display names (clearer vendor/product info).
- README documentation and examples.

## [0.2.5] and earlier

See git history for details.
