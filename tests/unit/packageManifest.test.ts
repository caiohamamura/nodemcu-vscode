import { describe, expect, it } from "vitest";
import manifest from "../../package.json";

describe("package manifest", () => {
  it("does not hard-block activation on optional language tooling", () => {
    expect(manifest).not.toHaveProperty("extensionDependencies");
    expect(manifest.extensionPack).toContain("sumneko.lua");
  });

  it("contributes device files and upload-monitor commands", () => {
    const views = manifest.contributes.views["nodemcu-vscode"].map((view) => view.id);
    const commands = manifest.contributes.commands.map((command) => command.command);
    expect(views).toContain("nodemcu.deviceFiles");
    expect(commands).toContain("nodemcu-vscode.uploadAndMonitor");
    expect(commands).toContain("nodemcu-vscode.openLiveDeviceFile");
  });

  it("declares shortcuts through contributes.keybindings", () => {
    const keybindings = manifest.contributes.keybindings;
    expect(keybindings).toContainEqual(expect.objectContaining({ command: "nodemcu-vscode.uploadAndMonitor", key: "f5" }));
    expect(keybindings).toContainEqual(expect.objectContaining({ command: "nodemcu-vscode.deleteFile", key: "delete" }));
    expect(manifest.contributes.commands.find((command) => command.command === "nodemcu-vscode.build")).not.toHaveProperty("key");
  });
});
