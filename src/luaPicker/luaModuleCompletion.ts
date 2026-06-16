import * as path from "node:path";
import * as vscode from "vscode";
import type { LuaModuleInfo } from "./moduleList";
import { selectMainFileForConfig } from "./moduleList";

export function luaModuleRequireText(moduleName: string): string {
  return `${moduleName} = require("${moduleName}")`;
}

export function luaModuleSource(module: LuaModuleInfo, config?: { lua_number_integral?: boolean }): string {
  const mainFile = selectMainFileForConfig(module, config);
  return `lua_modules/${module.dirName}/${path.basename(mainFile)}`;
}

export function createLuaModuleCompletionItem(module: LuaModuleInfo, config?: { lua_number_integral?: boolean }): vscode.CompletionItem {
  const item = new vscode.CompletionItem(module.name, vscode.CompletionItemKind.Module);
  item.detail = "NodeMCU Lua module";
  item.documentation = module.description || `Enable and require ${module.name}`;
  item.insertText = new vscode.SnippetString(luaModuleRequireText(module.name));
  item.filterText = module.name;
  item.sortText = `0_${module.name}`;
  item.command = {
    command: "nodemcu-vscode.acceptLuaModuleCompletion",
    title: "Enable and sync Lua module",
    arguments: [module.name, luaModuleSource(module, config)],
  };
  return item;
}
