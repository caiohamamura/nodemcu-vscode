import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  CompletionItemKind: { Module: 9 },
  CompletionItem: class {
    label: string;
    kind: number;
    detail?: string;
    documentation?: string;
    insertText?: unknown;
    filterText?: string;
    sortText?: string;
    command?: unknown;
    constructor(label: string, kind: number) {
      this.label = label;
      this.kind = kind;
    }
  },
  SnippetString: class {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
  },
}));

import { createLuaModuleCompletionItem, luaModuleRequireText, luaModuleSource } from "../../src/luaPicker/luaModuleCompletion";

describe("lua module completion helpers", () => {
  it("builds the require snippet text", () => {
    expect(luaModuleRequireText("ds18b20")).toBe('ds18b20 = require("ds18b20")');
  });

  it("uses firmware lua_modules source paths", () => {
    const source = luaModuleSource({
      name: "ds18b20",
      dirName: "ds18b20",
      description: "",
      mainFile: "/fw/lua_modules/ds18b20/ds18b20.lua",
      dir: "/fw/lua_modules/ds18b20",
      examples: [],
      allFiles: ["/fw/lua_modules/ds18b20/ds18b20.lua"],
    });
    expect(source).toBe("lua_modules/ds18b20/ds18b20.lua");
  });

  it("creates a completion item that enables and syncs the module on accept", () => {
    const item = createLuaModuleCompletionItem({
      name: "ds18b20",
      dirName: "ds18b20",
      description: "temperature sensor",
      mainFile: "/fw/lua_modules/ds18b20/ds18b20.lua",
      dir: "/fw/lua_modules/ds18b20",
      examples: [],
      allFiles: ["/fw/lua_modules/ds18b20/ds18b20.lua"],
    }) as any;
    expect(item.label).toBe("ds18b20");
    expect(item.insertText.value).toBe('ds18b20 = require("ds18b20")');
    expect(item.command.command).toBe("nodemcu-vscode.acceptLuaModuleCompletion");
    expect(item.command.arguments).toEqual(["ds18b20", "lua_modules/ds18b20/ds18b20.lua"]);
  });

  it("selects integer variant when lua_number_integral is true", () => {
    const source = luaModuleSource({
      name: "ds18b20",
      dirName: "ds18b20",
      description: "",
      mainFile: "/fw/lua_modules/ds18b20/ds18b20.lua",
      dir: "/fw/lua_modules/ds18b20",
      examples: [],
      allFiles: [
        "/fw/lua_modules/ds18b20/ds18b20.lua",
        "/fw/lua_modules/ds18b20/ds18b20-integer.lua",
      ],
    }, { lua_number_integral: true });
    expect(source).toBe("lua_modules/ds18b20/ds18b20-integer.lua");
  });

  it("completion item uses integer variant in command args when lua_number_integral is true", () => {
    const item = createLuaModuleCompletionItem({
      name: "ds18b20",
      dirName: "ds18b20",
      description: "temperature sensor",
      mainFile: "/fw/lua_modules/ds18b20/ds18b20.lua",
      dir: "/fw/lua_modules/ds18b20",
      examples: [],
      allFiles: [
        "/fw/lua_modules/ds18b20/ds18b20.lua",
        "/fw/lua_modules/ds18b20/ds18b20-integer.lua",
      ],
    }, { lua_number_integral: true }) as any;
    expect(item.command.arguments).toEqual(["ds18b20", "lua_modules/ds18b20/ds18b20-integer.lua"]);
  });
});
