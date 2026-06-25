import * as vscode from "vscode";

export type FontLib = "u8g2" | "ucg";

/**
 * Completion item for a u8g2/ucg font referenced as `u8g2.font_*` / `ucg.font_*`.
 * Fonts already compiled into the firmware sort first and carry no side effect.
 * Fonts not yet compiled attach a command that enables them in nodemcu.ini on
 * accept (the same `enable*FontFromFix` handlers used by the diagnostics
 * quick-fix), so picking one both inserts the name and schedules it for the
 * next build — mirroring how accepting a Lua-module completion enables it.
 */
export function createFontCompletionItem(lib: FontLib, font: string, compiled: boolean): vscode.CompletionItem {
  const item = new vscode.CompletionItem(font, vscode.CompletionItemKind.EnumMember);
  item.filterText = font;
  item.insertText = font;
  // Compiled fonts first ("0_"), then the rest of the catalog ("1_").
  item.sortText = `${compiled ? "0" : "1"}_${font}`;
  item.detail = compiled ? `${lib} font (compiled in)` : `${lib} font — adds to nodemcu.ini`;
  if (!compiled) {
    item.command = {
      command: lib === "u8g2" ? "nodemcu-vscode.enableU8g2FontFromFix" : "nodemcu-vscode.enableUcgFontFromFix",
      title: "Compile font into firmware",
      arguments: [font],
    };
    item.documentation = new vscode.MarkdownString(
      `Inserts \`${font}\` and adds it to **nodemcu.ini** \`[${lib}_fonts]\` so it is compiled into the next firmware build.`,
    );
  }
  return item;
}
