# Changelog

All notable changes to the NodeMCU VSCode extension are documented here.

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
