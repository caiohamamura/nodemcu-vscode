import { describe, it, expect } from "vitest";
import { quoteArg, formatCommand, type CommandSpec } from "../../src/util/shell";

describe("quoteArg", () => {
  it("passes through simple args on posix", () => {
    expect(quoteArg("hello", "linux")).toBe("hello");
  });

  it("quotes args with spaces on posix", () => {
    expect(quoteArg("hello world", "linux")).toBe("'hello world'");
  });

  it("escapes single quotes on posix", () => {
    expect(quoteArg("it's", "linux")).toBe("'it'\\''s'");
  });

  it("quotes args with special chars on windows", () => {
    expect(quoteArg("hello world", "win32")).toBe('"hello world"');
  });

  it("escapes double quotes on windows", () => {
    expect(quoteArg('say "hi"', "win32")).toBe('"say ""hi"""');
  });
});

describe("formatCommand", () => {
  it("joins a command and args with quoting", () => {
    const spec: CommandSpec = {
      command: "cmake",
      args: ["-S", "some path", "-G", "Ninja"],
    };
    expect(formatCommand(spec, "linux")).toBe(`cmake -S 'some path' -G Ninja`);
  });
});
