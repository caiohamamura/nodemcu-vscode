import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  CompletionItemKind: { EnumMember: 19 },
  CompletionItem: class {
    label: string;
    kind: number;
    detail?: string;
    documentation?: unknown;
    insertText?: unknown;
    filterText?: string;
    sortText?: string;
    command?: unknown;
    constructor(label: string, kind: number) {
      this.label = label;
      this.kind = kind;
    }
  },
  MarkdownString: class {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
  },
}));

import { createFontCompletionItem } from "../../src/luaPicker/fontCompletion";

describe("font completion items", () => {
  it("attaches an enable command for a font that isn't compiled yet", () => {
    const item = createFontCompletionItem("u8g2", "font_logisoso16_tf", false) as any;
    expect(item.label).toBe("font_logisoso16_tf");
    expect(item.insertText).toBe("font_logisoso16_tf");
    expect(item.command.command).toBe("nodemcu-vscode.enableU8g2FontFromFix");
    expect(item.command.arguments).toEqual(["font_logisoso16_tf"]);
    expect(item.sortText).toBe("1_font_logisoso16_tf");
  });

  it("sorts compiled fonts first and adds no side-effect command", () => {
    const item = createFontCompletionItem("u8g2", "font_6x10_tf", true) as any;
    expect(item.command).toBeUndefined();
    expect(item.sortText).toBe("0_font_6x10_tf");
    expect(item.detail).toContain("compiled in");
  });

  it("uses the ucg enable command for ucg fonts", () => {
    const item = createFontCompletionItem("ucg", "font_helvB18_hr", false) as any;
    expect(item.command.command).toBe("nodemcu-vscode.enableUcgFontFromFix");
  });
});
