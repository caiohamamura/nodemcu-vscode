import * as fs from "node:fs";
import type { NodemcuConfig } from "../config/nodemcuIni";
import { listU8g2Displays, listUcgDisplays, type DisplayCatalogEntry } from "../firmware/graphicsCatalog";

/**
 * Regenerate the active table block inside the firmware's hand-edited graphics
 * config headers (u8g2_fonts.h, u8g2_displays.h, ucg_config.h) from the
 * nodemcu.ini [u8g2_fonts]/[u8g2_displays]/[ucg_fonts]/[ucg_displays] sections.
 *
 * These headers carry their full driver catalog as commented-out
 * `*_TABLE_ENTRY(...)` lines; we only rewrite the *active* `#define <TABLE> \`
 * continuation block and leave the comments (the catalog) untouched. The
 * transforms are pure string ops over file content so they stay unit-testable,
 * mirroring setUserConfigSsl/Lfs/BitRate in userModulesWriter.ts.
 */

interface TableSpec {
  /** The macro the table assigns to, e.g. `U8G2_FONT_TABLE`. */
  macro: string;
  /** The per-entry macro, e.g. `U8G2_FONT_TABLE_ENTRY`. */
  entry: string;
}

function blockRegex(spec: TableSpec): RegExp {
  // Matches `#define <macro> \\\n` followed by the contiguous run of indented
  // `<entry>(...)` continuation lines. Non-global: only the first (active)
  // occurrence is touched, never the `#else`/`#ifdef ..._EXTRA` fallback that
  // follows it in these headers.
  return new RegExp(
    `(#define[ \\t]+${spec.macro}[ \\t]*\\\\\\r?\\n)` +
      `((?:[ \\t]*${spec.entry}\\([^)]*\\)[ \\t]*\\\\?\\r?\\n)*)`,
  );
}

/** Render entry lines: every line but the last is backslash-continued. */
function renderEntries(entry: string, args: string[]): string {
  if (args.length === 0) return "";
  return args
    .map((a, i) => `  ${entry}(${a})${i === args.length - 1 ? "" : " \\"}`)
    .join("\n") + "\n";
}

/**
 * Replace the active entries of `spec`'s table with `args`. Returns the original
 * content unchanged when the table macro is absent or `args` is empty (so an
 * empty config preserves the firmware's shipped default rather than blanking it).
 */
function replaceTable(content: string, spec: TableSpec, args: string[]): string {
  if (args.length === 0) return content;
  const re = blockRegex(spec);
  if (!re.test(content)) return content;
  return content.replace(re, (_full, header: string) => header + renderEntries(spec.entry, args));
}

/** Bare entry argument list currently active in `spec`'s table (argIndex-th arg). */
export function activeTableEntries(content: string, spec: TableSpec, argIndex = 0): string[] {
  const re = blockRegex(spec);
  const m = re.exec(content);
  if (!m) return [];
  const block = m[2] ?? "";
  const entryRe = new RegExp(`${spec.entry}\\(([^)]*)\\)`, "g");
  const out: string[] = [];
  let e: RegExpExecArray | null;
  while ((e = entryRe.exec(block)) !== null) {
    const arg = (e[1].split(",")[argIndex] ?? "").trim();
    if (arg) out.push(arg);
  }
  return out;
}

const U8G2_FONT: TableSpec = { macro: "U8G2_FONT_TABLE", entry: "U8G2_FONT_TABLE_ENTRY" };
const U8G2_I2C: TableSpec = { macro: "U8G2_DISPLAY_TABLE_I2C", entry: "U8G2_DISPLAY_TABLE_ENTRY" };
const U8G2_SPI: TableSpec = { macro: "U8G2_DISPLAY_TABLE_SPI", entry: "U8G2_DISPLAY_TABLE_ENTRY" };
const UCG_FONT: TableSpec = { macro: "UCG_FONT_TABLE", entry: "UCG_FONT_TABLE_ENTRY" };
const UCG_DISPLAY: TableSpec = { macro: "UCG_DISPLAY_TABLE", entry: "UCG_DISPLAY_TABLE_ENTRY" };

function enabledKeys(section: Record<string, boolean>): string[] {
  return Object.entries(section)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort();
}

// ---- u8g2 fonts ----------------------------------------------------------

export function setU8g2FontsContent(content: string, config: NodemcuConfig): string {
  return replaceTable(content, U8G2_FONT, enabledKeys(config.u8g2_fonts));
}

export function activeU8g2Fonts(content: string): string[] {
  return activeTableEntries(content, U8G2_FONT, 0);
}

// ---- u8g2 displays (split into I2C / SPI tables) -------------------------

function u8g2DisplayEntryLines(
  bindings: string[],
  catalog: DisplayCatalogEntry[],
  bus: "i2c" | "spi",
): string[] {
  const byBinding = new Map(catalog.map((d) => [d.binding, d]));
  return bindings
    .map((b) => byBinding.get(b))
    .filter((d): d is DisplayCatalogEntry => !!d && d.bus === bus)
    .map((d) => `${d.setup}, ${d.binding}`);
}

export function setU8g2DisplaysContent(content: string, config: NodemcuConfig, catalog: DisplayCatalogEntry[]): string {
  const bindings = enabledKeys(config.u8g2_displays);
  let out = replaceTable(content, U8G2_I2C, u8g2DisplayEntryLines(bindings, catalog, "i2c"));
  out = replaceTable(out, U8G2_SPI, u8g2DisplayEntryLines(bindings, catalog, "spi"));
  return out;
}

export function activeU8g2Displays(content: string): string[] {
  return [
    ...activeTableEntries(content, U8G2_I2C, 1),
    ...activeTableEntries(content, U8G2_SPI, 1),
  ];
}

// ---- ucg fonts + displays (both live in ucg_config.h) --------------------

export function setUcgContent(content: string, config: NodemcuConfig, displayCatalog: DisplayCatalogEntry[]): string {
  let out = replaceTable(content, UCG_FONT, enabledKeys(config.ucg_fonts));
  const byBinding = new Map(displayCatalog.map((d) => [d.binding, d]));
  const displayArgs = enabledKeys(config.ucg_displays)
    .map((b) => byBinding.get(b))
    .filter((d): d is DisplayCatalogEntry => !!d)
    .map((d) => `${d.binding}, ${d.setup}, ${d.extension}`);
  out = replaceTable(out, UCG_DISPLAY, displayArgs);
  return out;
}

export function activeUcgFonts(content: string): string[] {
  return activeTableEntries(content, UCG_FONT, 0);
}

export function activeUcgDisplays(content: string): string[] {
  return activeTableEntries(content, UCG_DISPLAY, 0);
}

// ---- on-disk writers (return true when the file changed) -----------------

function writeIfChanged(headerPath: string, transform: (content: string) => string): boolean {
  if (!fs.existsSync(headerPath)) return false;
  const before = fs.readFileSync(headerPath, "utf-8");
  const after = transform(before);
  if (after === before) return false;
  fs.writeFileSync(headerPath, after, "utf-8");
  return true;
}

export function writeU8g2FontsHeader(headerPath: string, config: NodemcuConfig): boolean {
  return writeIfChanged(headerPath, (c) => setU8g2FontsContent(c, config));
}

export function writeU8g2DisplaysHeader(headerPath: string, config: NodemcuConfig, firmwarePath: string): boolean {
  const catalog = listU8g2Displays(firmwarePath);
  return writeIfChanged(headerPath, (c) => setU8g2DisplaysContent(c, config, catalog));
}

export function writeUcgConfigHeader(headerPath: string, config: NodemcuConfig, firmwarePath: string): boolean {
  const catalog = listUcgDisplays(firmwarePath);
  return writeIfChanged(headerPath, (c) => setUcgContent(c, config, catalog));
}

// ---- helpers for quick-fix seeding (read currently-compiled entries) -----

export function readActiveEntries(headerPath: string, kind: "u8g2Font" | "u8g2Display" | "ucgFont" | "ucgDisplay"): string[] {
  let content = "";
  try {
    content = fs.readFileSync(headerPath, "utf-8");
  } catch {
    return [];
  }
  switch (kind) {
    case "u8g2Font": return activeU8g2Fonts(content);
    case "u8g2Display": return activeU8g2Displays(content);
    case "ucgFont": return activeUcgFonts(content);
    case "ucgDisplay": return activeUcgDisplays(content);
  }
}
