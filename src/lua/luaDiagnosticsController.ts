import * as fs from "node:fs";
import * as vscode from "vscode";
import { isLfsEnabled, type NodemcuConfig } from "../config/nodemcuIni";
import { KNOWN_MODULES, MANDATORY_C_MODULES } from "../build/userModulesWriter";
import { listU8g2Fonts, listUcgFonts } from "../firmware/graphicsCatalog";
import { activeU8g2Fonts, activeUcgFonts } from "../build/graphicsConfigWriter";
import { u8g2FontsHeader, ucgConfigHeader } from "../util/paths";
import { listLuaModulesFromFirmware } from "../luaPicker/moduleList";
import { computeLuaDiagnostics, type LuaDiagnostic, type LuaDiagnosticsContext } from "./luaDiagnostics";

function readActiveFonts(headerPath: string, parse: (content: string) => string[]): Set<string> {
  try {
    return new Set(parse(fs.readFileSync(headerPath, "utf-8")));
  } catch {
    return new Set();
  }
}

export interface DiagnosticsDeps {
  getConfig(): NodemcuConfig | null;
  getFirmwarePath(): Promise<string | null>;
  log?(message: string): void;
}

interface FirmwareCatalog {
  u8g2Fonts: Set<string>;
  ucgFonts: Set<string>;
  luaModules: Set<string>;
  // Fonts currently compiled into the firmware headers — used as the "enabled"
  // set when the nodemcu.ini section is empty (i.e. firmware defaults are live).
  activeU8g2Fonts: Set<string>;
  activeUcgFonts: Set<string>;
}

/**
 * Owns the "nodemcu" diagnostic collection for Lua files and keeps it in sync
 * with the open editors, the nodemcu.ini config, and the firmware catalog. The
 * heavy firmware catalog (≈1100 u8g2 + ≈1200 ucg font names, plus the Lua module
 * list) is parsed once per firmware path and cached.
 */
export class LuaDiagnosticsController {
  private readonly collection: vscode.DiagnosticCollection;
  private catalog: FirmwareCatalog | null = null;
  private catalogKey: string | null = null;
  private catalogPromise: Promise<FirmwareCatalog | null> | null = null;
  private readonly debounce = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: DiagnosticsDeps) {
    this.collection = vscode.languages.createDiagnosticCollection("nodemcu");
  }

  dispose(): void {
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    this.collection.dispose();
  }

  /** Re-analyze every open Lua document (e.g. after the config changed). */
  refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === "lua") void this.analyze(doc);
    }
  }

  onOpen(doc: vscode.TextDocument): void {
    if (doc.languageId === "lua") void this.analyze(doc);
  }

  onChange(doc: vscode.TextDocument): void {
    if (doc.languageId !== "lua") return;
    const key = doc.uri.toString();
    const existing = this.debounce.get(key);
    if (existing) clearTimeout(existing);
    this.debounce.set(key, setTimeout(() => {
      this.debounce.delete(key);
      void this.analyze(doc);
    }, 400));
  }

  onClose(doc: vscode.TextDocument): void {
    this.collection.delete(doc.uri);
  }

  /** Config changed → the firmware path may differ; drop the catalog cache. */
  invalidateCatalog(): void {
    this.catalog = null;
    this.catalogKey = null;
    this.catalogPromise = null;
  }

  private async loadCatalog(): Promise<FirmwareCatalog | null> {
    const fw = await this.deps.getFirmwarePath();
    if (!fw) return null;
    if (this.catalog && this.catalogKey === fw) return this.catalog;
    if (this.catalogPromise && this.catalogKey === fw) return this.catalogPromise;
    this.catalogKey = fw;
    this.catalogPromise = (async () => {
      const modules = await listLuaModulesFromFirmware(fw).catch(() => []);
      const cat: FirmwareCatalog = {
        u8g2Fonts: new Set(listU8g2Fonts(fw)),
        ucgFonts: new Set(listUcgFonts(fw)),
        luaModules: new Set(modules.map((m) => m.name)),
        activeU8g2Fonts: readActiveFonts(u8g2FontsHeader(fw), activeU8g2Fonts),
        activeUcgFonts: readActiveFonts(ucgConfigHeader(fw), activeUcgFonts),
      };
      this.catalog = cat;
      return cat;
    })();
    return this.catalogPromise;
  }

  private buildContext(config: NodemcuConfig, catalog: FirmwareCatalog): LuaDiagnosticsContext {
    const enabledCModules = new Set<string>(MANDATORY_C_MODULES);
    for (const [name, on] of Object.entries(config.c_modules)) {
      if (on) enabledCModules.add(name.toLowerCase());
    }
    const enabledKeys = (section: Record<string, boolean>) =>
      new Set(Object.entries(section).filter(([, v]) => v).map(([k]) => k));
    // An empty nodemcu.ini section means the build leaves the firmware header at
    // its shipped default, so the fonts actually compiled in are the header's
    // current active entries — treat those as enabled to avoid false warnings.
    const enabledFonts = (section: Record<string, boolean>, active: Set<string>) => {
      const keys = enabledKeys(section);
      return keys.size > 0 ? keys : active;
    };
    return {
      lfsEnabled: isLfsEnabled(config),
      enabledCModules,
      knownCModules: KNOWN_MODULES,
      mandatoryCModules: MANDATORY_C_MODULES,
      enabledLuaModules: new Set(Object.keys(config.lua_modules)),
      availableLuaModules: catalog.luaModules,
      u8g2Available: catalog.u8g2Fonts.size > 0,
      u8g2FontCatalog: catalog.u8g2Fonts,
      enabledU8g2Fonts: enabledFonts(config.u8g2_fonts, catalog.activeU8g2Fonts),
      ucgAvailable: catalog.ucgFonts.size > 0,
      ucgFontCatalog: catalog.ucgFonts,
      enabledUcgFonts: enabledFonts(config.ucg_fonts, catalog.activeUcgFonts),
    };
  }

  private async analyze(doc: vscode.TextDocument): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) {
      this.collection.delete(doc.uri);
      return;
    }
    const catalog = await this.loadCatalog();
    if (!catalog) return;
    // The document may have changed/closed while the catalog loaded.
    if (doc.isClosed) return;
    const ctx = this.buildContext(config, catalog);
    const diags = computeLuaDiagnostics(doc.getText(), ctx).map((d) => toVsDiagnostic(d));
    this.collection.set(doc.uri, diags);
  }
}

function toVsDiagnostic(d: LuaDiagnostic): vscode.Diagnostic {
  const range = new vscode.Range(d.line, d.startCol, d.line, d.endCol);
  const severity =
    d.severity === "error" ? vscode.DiagnosticSeverity.Error
    : d.severity === "warning" ? vscode.DiagnosticSeverity.Warning
    : vscode.DiagnosticSeverity.Information;
  const diag = new vscode.Diagnostic(range, d.message, severity);
  diag.source = "NodeMCU";
  diag.code = d.code;
  return diag;
}
