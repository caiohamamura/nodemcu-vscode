import * as vscode from "vscode";

/**
 * Offers quick-fixes for the diagnostics produced by {@link computeLuaDiagnostics}.
 * Each fix delegates to a `nodemcu-vscode.*FromFix` command (registered in
 * extension.ts) that edits nodemcu.ini — so accepting the fix enables the module
 * or font and, where relevant, kicks off a sync/rebuild.
 */
export class NodemcuLuaCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      const code = typeof diag.code === "string" ? diag.code : "";
      const sep = code.indexOf(":");
      if (sep === -1) continue;
      const kind = code.slice(0, sep);
      const name = code.slice(sep + 1);

      // LFS require → in-document text edit (not a nodemcu.ini change).
      if (kind === "nodemcu.lfsRequire") {
        const title = `Replace require with node.LFS.get("${name}")()`;
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diag];
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(doc.uri, diag.range, `node.LFS.get("${name}")()`);
        actions.push(action);
        continue;
      }

      const spec = FIX_SPECS[kind];
      if (!spec) continue;
      const action = new vscode.CodeAction(spec.title(name), vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diag];
      action.command = { command: spec.command, title: spec.title(name), arguments: [name] };
      actions.push(action);
    }
    return actions;
  }
}

const FIX_SPECS: Record<string, { command: string; title: (name: string) => string }> = {
  "nodemcu.cModule": {
    command: "nodemcu-vscode.enableCModuleFromFix",
    title: (n) => `Enable C module "${n}" in nodemcu.ini`,
  },
  "nodemcu.luaModule": {
    command: "nodemcu-vscode.enableLuaModuleFromFix",
    title: (n) => `Enable Lua module "${n}" in nodemcu.ini`,
  },
  "nodemcu.u8g2Font": {
    command: "nodemcu-vscode.enableU8g2FontFromFix",
    title: (n) => `Compile u8g2 font "${n}" into the firmware`,
  },
  "nodemcu.ucgFont": {
    command: "nodemcu-vscode.enableUcgFontFromFix",
    title: (n) => `Compile ucg font "${n}" into the firmware`,
  },
};
