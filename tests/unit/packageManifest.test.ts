import { describe, expect, it } from "vitest";
import manifest from "../../package.json";

describe("package manifest", () => {
  it("does not hard-block activation on optional language tooling", () => {
    expect(manifest).not.toHaveProperty("extensionDependencies");
    expect(manifest.extensionPack).toContain("sumneko.lua");
  });

  it("contributes workspace-backed NodeMCU side views and the serial bottom panel", () => {
    const views = manifest.contributes.views["nodemcu-vscode"].map((view) => view.id);
    const serialViews = manifest.contributes.views["nodemcu-serial-panel"];
    const commands = manifest.contributes.commands.map((command) => command.command);
    expect(views).toEqual(["nodemcu.deviceExplorer", "nodemcu.projectTasks", "nodemcu.luaModules", "nodemcu.cModules"]);
    expect(serialViews).toEqual([
      expect.objectContaining({ id: "nodemcu.serialConsole", type: "webview" }),
    ]);
    expect(manifest.contributes.viewsContainers.panel).toContainEqual(
      expect.objectContaining({ id: "nodemcu-serial-panel", title: "NodeMCU Serial" }),
    );
    expect(views).not.toContain("nodemcu.deviceFiles");
    expect(commands).toContain("nodemcu-vscode.uploadAndMonitor");
    expect(commands).toContain("nodemcu-vscode.releaseSerialPort");
    expect(commands).not.toContain("nodemcu-vscode.connectSerialSession");
    expect(commands).not.toContain("nodemcu-vscode.openLiveDeviceFile");
    expect(commands).not.toContain("nodemcu-vscode.downloadFile");
    expect(commands).not.toContain("nodemcu-vscode.deleteFile");
  });

  it("declares shortcuts through contributes.keybindings", () => {
    const keybindings = manifest.contributes.keybindings;
    expect(keybindings).toContainEqual(expect.objectContaining({ command: "nodemcu-vscode.uploadAndMonitor", key: "f5" }));
    expect(keybindings).not.toContainEqual(expect.objectContaining({ command: "nodemcu-vscode.deleteFile", key: "delete" }));
    expect(manifest.contributes.commands.find((command) => command.command === "nodemcu-vscode.build")).not.toHaveProperty("key");
  });
});
