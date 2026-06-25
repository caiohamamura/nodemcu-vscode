/**
 * Pure (vscode-free) analysis of a Lua document against the current nodemcu.ini
 * configuration + firmware catalog. Produces diagnostics for:
 *   - C-module globals used in code but not enabled in [c_modules]
 *   - Lua modules required() but not enabled in [lua_modules]
 *   - u8g2/ucg fonts referenced (`u8g2.font_*`) but not compiled into the image
 *
 * Each fixable diagnostic carries a `code` of the form `<actionKind>:<name>` so
 * the code-action provider can offer a quick-fix that edits nodemcu.ini. Kept
 * pure so it is unit-testable without a running editor; the controller maps the
 * descriptors onto vscode.Diagnostic.
 */

export type DiagnosticActionKind =
  | "nodemcu.cModule"
  | "nodemcu.luaModule"
  | "nodemcu.u8g2Font"
  | "nodemcu.ucgFont"
  | "nodemcu.unknownFont";

export interface LuaDiagnostic {
  line: number;
  startCol: number;
  endCol: number;
  message: string;
  severity: "warning" | "info";
  /** `<actionKind>:<name>` for fixable diagnostics, or a bare kind otherwise. */
  code: string;
}

export interface LuaDiagnosticsContext {
  enabledCModules: Set<string>;
  knownCModules: Set<string>;
  mandatoryCModules: Set<string>;
  enabledLuaModules: Set<string>;
  availableLuaModules: Set<string>;
  u8g2Available: boolean;
  u8g2FontCatalog: Set<string>;
  enabledU8g2Fonts: Set<string>;
  ucgAvailable: boolean;
  ucgFontCatalog: Set<string>;
  enabledUcgFonts: Set<string>;
}

/** Strip a Lua line comment (`-- ...`) so we don't scan commented-out code. */
function stripLineComment(line: string): string {
  const idx = line.indexOf("--");
  return idx === -1 ? line : line.slice(0, idx);
}

const REQUIRE_RE = /\brequire\s*\(\s*["']([\w.\-]+)["']/g;
const CMODULE_RE = /(^|[^.\w])([A-Za-z_][A-Za-z0-9_]*)\s*\./g;
const FONT_RE = /\b(u8g2|ucg)\.(font_[A-Za-z0-9_]+)/g;

export function computeLuaDiagnostics(text: string, ctx: LuaDiagnosticsContext): LuaDiagnostic[] {
  const out: LuaDiagnostic[] = [];
  const reportedCModule = new Set<string>();
  const reportedLuaModule = new Set<string>();
  const reportedFont = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (let line = 0; line < lines.length; line++) {
    const code = stripLineComment(lines[line]);

    let m: RegExpExecArray | null;

    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(code)) !== null) {
      const name = m[1];
      if (!ctx.availableLuaModules.has(name) || ctx.enabledLuaModules.has(name)) continue;
      if (reportedLuaModule.has(name)) continue;
      reportedLuaModule.add(name);
      const start = m.index + m[0].indexOf(name);
      out.push({
        line, startCol: start, endCol: start + name.length,
        message: `Lua module "${name}" is required but not enabled in nodemcu.ini [lua_modules].`,
        severity: "warning", code: `nodemcu.luaModule:${name}`,
      });
    }

    FONT_RE.lastIndex = 0;
    while ((m = FONT_RE.exec(code)) !== null) {
      const lib = m[1] as "u8g2" | "ucg";
      const font = m[2];
      const key = `${lib}.${font}`;
      if (reportedFont.has(key)) continue;
      const available = lib === "u8g2" ? ctx.u8g2Available : ctx.ucgAvailable;
      if (!available) continue;
      const catalog = lib === "u8g2" ? ctx.u8g2FontCatalog : ctx.ucgFontCatalog;
      const enabled = lib === "u8g2" ? ctx.enabledU8g2Fonts : ctx.enabledUcgFonts;
      const start = m.index + m[0].indexOf(font);
      const range = { line, startCol: start, endCol: start + font.length };
      if (!catalog.has(font)) {
        reportedFont.add(key);
        out.push({
          ...range,
          message: `Unknown ${lib} font "${font}" — not found in the firmware font library.`,
          severity: "warning", code: "nodemcu.unknownFont",
        });
      } else if (!enabled.has(font)) {
        reportedFont.add(key);
        const kind = lib === "u8g2" ? "nodemcu.u8g2Font" : "nodemcu.ucgFont";
        out.push({
          ...range,
          message: `${lib} font "${font}" is not compiled into the firmware. Add it in nodemcu.ini and rebuild.`,
          severity: "warning", code: `${kind}:${font}`,
        });
      }
    }

    CMODULE_RE.lastIndex = 0;
    while ((m = CMODULE_RE.exec(code)) !== null) {
      const ident = m[2];
      const lower = ident.toLowerCase();
      if (!ctx.knownCModules.has(lower)) continue;
      if (ctx.mandatoryCModules.has(lower) || ctx.enabledCModules.has(lower)) continue;
      // A `u8g2.font_*` / `ucg.font_*` access is a font reference handled by the
      // font rule above; don't also report the display lib as a disabled module.
      if ((lower === "u8g2" || lower === "ucg") && code.slice(m.index + m[0].length).startsWith("font_")) continue;
      if (reportedCModule.has(lower)) continue;
      reportedCModule.add(lower);
      const start = m.index + m[0].indexOf(ident);
      out.push({
        line, startCol: start, endCol: start + ident.length,
        message: `C module "${lower}" is used but not enabled in nodemcu.ini [c_modules].`,
        severity: "warning", code: `nodemcu.cModule:${lower}`,
      });
    }
  }

  return out;
}
