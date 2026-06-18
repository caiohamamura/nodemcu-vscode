import { describe, it, expect } from "vitest";
import { lfsImageCommand, buildLfsImage } from "../../src/build/lfsBuilder";
import { Shell, type ShellRunOptions, type ShellRunResult } from "../../src/util/shell";

class FakeShell extends Shell {
  calls: Array<{ command: string; args: string[] }> = [];
  next: Partial<ShellRunResult> = { exitCode: 0 };
  async run(command: string, args: string[], _opts: ShellRunOptions = {}): Promise<ShellRunResult> {
    this.calls.push({ command, args });
    return { exitCode: 0, signal: null, stdout: "", stderr: "", ...this.next };
  }
}

describe("lfsImageCommand", () => {
  it("builds the luac.cross flash-image argv", () => {
    const cmd = lfsImageCommand({
      luacCross: "/fw/build/tools/luac_cross/luac.cross",
      files: ["/p/a.lua", "/p/b.lua"],
      outPath: "/fw/build/lfs.img",
      maxSize: 0x20000,
    });
    expect(cmd.command).toBe("/fw/build/tools/luac_cross/luac.cross");
    expect(cmd.args).toEqual(["-f", "-m", "131072", "-o", "/fw/build/lfs.img", "/p/a.lua", "/p/b.lua"]);
  });
});

describe("buildLfsImage", () => {
  it("fails fast with no input files (does not spawn luac.cross)", async () => {
    const shell = new FakeShell();
    const r = await buildLfsImage(shell, { luacCross: "luac.cross", files: [], outPath: "/o", maxSize: 1024 });
    expect(r.success).toBe(false);
    expect(shell.calls).toHaveLength(0);
  });

  it("succeeds on exit 0", async () => {
    const shell = new FakeShell();
    const r = await buildLfsImage(shell, { luacCross: "lc", files: ["/a.lua"], outPath: "/o", maxSize: 1024 });
    expect(r.success).toBe(true);
    expect(r.outPath).toBe("/o");
    expect(shell.calls[0].command).toBe("lc");
  });

  it("reports stderr on non-zero exit", async () => {
    const shell = new FakeShell();
    shell.next = { exitCode: 1, stderr: "luac.cross: out of memory" };
    const r = await buildLfsImage(shell, { luacCross: "lc", files: ["/a.lua"], outPath: "/o", maxSize: 1024 });
    expect(r.success).toBe(false);
    expect(r.error).toContain("out of memory");
  });
});
