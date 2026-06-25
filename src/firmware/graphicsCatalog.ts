import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Catalog of u8g2/ucg fonts and display drivers available in the managed
 * firmware. Fonts are read from the never-modified library headers
 * (app/u8g2lib/u8g2/src/clib/u8g2.h, app/ucglib/ucg/src/clib/ucg.h); display
 * drivers are read from the NodeMCU config headers (app/include/u8g2_displays.h,
 * ucg_config.h) where the full driver list lives as commented-out table entries.
 * Those config headers keep their comment catalog even after the build
 * regenerates their active table block, so this stays a reliable source.
 *
 * Names are stored "bare" — fonts without the `u8g2_`/`ucg_` prefix (matching
 * how the firmware tables and the Lua `u8g2.font_*` references spell them), and
 * displays by their binding name (the identifier the firmware exposes).
 */

export interface DisplayCatalogEntry {
  /** Binding name exposed by the firmware / used as the nodemcu.ini key. */
  binding: string;
  /** u8g2 setup function (u8g2_Setup_*) or ucg device function. */
  setup: string;
  /** Bus for u8g2 displays (which table the entry belongs in). */
  bus?: "i2c" | "spi";
  /** ucg extension argument (3rd arg of UCG_DISPLAY_TABLE_ENTRY). */
  extension?: string;
}

function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

function u8g2LibHeader(fw: string): string {
  return path.join(fw, "app", "u8g2lib", "u8g2", "src", "clib", "u8g2.h");
}

function ucgLibHeader(fw: string): string {
  return path.join(fw, "app", "ucglib", "ucg", "src", "clib", "ucg.h");
}

/** Bare font names (`font_...`) declared in a library header as `<prefix>_font_*`. */
function fontsFromHeader(content: string, prefix: string): string[] {
  const re = new RegExp(`\\b${prefix}_(font_[A-Za-z0-9_]+)\\b`, "g");
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    seen.add(m[1]);
  }
  return Array.from(seen).sort();
}

export function listU8g2Fonts(firmwarePath: string): string[] {
  return fontsFromHeader(readFileOrEmpty(u8g2LibHeader(firmwarePath)), "u8g2");
}

export function listUcgFonts(firmwarePath: string): string[] {
  return fontsFromHeader(readFileOrEmpty(ucgLibHeader(firmwarePath)), "ucg");
}

// Placeholder identifiers used in the `#define ..._TABLE_ENTRY(...)` macro
// definition lines themselves; never real bindings.
const PLACEHOLDER_ARGS = new Set(["function", "binding", "device", "extension"]);

export function listU8g2Displays(firmwarePath: string): DisplayCatalogEntry[] {
  const content = readFileOrEmpty(path.join(firmwarePath, "app", "include", "u8g2_displays.h"));
  const re = /U8G2_DISPLAY_TABLE_ENTRY\(\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*\)/g;
  const byBinding = new Map<string, DisplayCatalogEntry>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const setup = m[1];
    const binding = m[2];
    if (PLACEHOLDER_ARGS.has(binding) || PLACEHOLDER_ARGS.has(setup)) continue;
    byBinding.set(binding, { binding, setup, bus: /_i2c_/.test(setup) ? "i2c" : "spi" });
  }
  return Array.from(byBinding.values()).sort((a, b) => a.binding.localeCompare(b.binding));
}

export function listUcgDisplays(firmwarePath: string): DisplayCatalogEntry[] {
  const content = readFileOrEmpty(path.join(firmwarePath, "app", "include", "ucg_config.h"));
  const re = /UCG_DISPLAY_TABLE_ENTRY\(\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*\)/g;
  const byBinding = new Map<string, DisplayCatalogEntry>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const binding = m[1];
    const setup = m[2];
    const extension = m[3];
    if (PLACEHOLDER_ARGS.has(binding)) continue;
    byBinding.set(binding, { binding, setup, extension });
  }
  return Array.from(byBinding.values()).sort((a, b) => a.binding.localeCompare(b.binding));
}
