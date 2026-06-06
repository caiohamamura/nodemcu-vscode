import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { Shell } from "./util/shell";
import {
  loadConfig,
  saveConfig,
  defaultConfig,
  setCModule,
  setLuaModule,
  type NodemcuConfig,
} from "./config/nodemcuIni";
import { ConfigWatcher } from "./config/configWatcher";
import { resolveFirmwarePath, luaModulesDir } from "./util/paths";
import { BuildManager } from "./build/buildManager";
import { ToolchainLocator } from "./build/toolchain";
import { FlashManager } from "./flash/flashManager";
import { SerialDiscovery } from "./flash/serialDiscovery";
import { NodemcuTool } from "./upload/nodemcuTool";
import { StatusEmitter, type BuildState } from "./status/statusBar";
import { listLuaModulesFromFirmware, listCModules, type LuaModuleInfo, type CModuleInfo } from "./luaPicker/moduleList";
import { resolveAllLuaModules } from "./luaPicker/luaModuleResolver";
import { generateLuaApiFile, writeLuaRc } from "./luaApi/apiFiles";

let outputChannel: vscode.OutputChannel;
let statusEmitter: StatusEmitter;
let statusBarItem: vscode.StatusBarItem;
let watcher: ConfigWatcher | undefined;
let cachedConfig: NodemcuConfig | null = null;
let cachedFirmwarePath: string | null = null;

class AsyncTreeProvider implements vscode.TreeDataProvider<TreeItemNode> {
  private _onDidChange = new vscode.EventEmitter<TreeItemNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private cache: TreeItemNode[] = [];

  constructor(private loader: () => Promise<TreeItemNode[]>) {}

  refresh(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.cache = await this.loader();
    this._onDidChange.fire(undefined);
  }

  getTreeItem(el: TreeItemNode): vscode.TreeItem {
    const item = new vscode.TreeItem(el.label, el.collapsibleState);
    if (el.description) item.description = el.description;
    if (el.contextValue) item.contextValue = el.contextValue;
    if (el.iconPath) item.iconPath = el.iconPath;
    if (el.command) item.command = el.command;
    if (el.resourceUri) item.resourceUri = el.resourceUri;
    return item;
  }

  getChildren(el?: TreeItemNode): TreeItemNode[] {
    if (!el) return this.cache;
    return el.children ?? [];
  }
}

interface TreeItemNode {
  id: string;
  label: string;
  description?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  contextValue?: string;
  iconPath?: vscode.ThemeIcon;
  command?: vscode.Command;
  resourceUri?: vscode.Uri;
  children?: TreeItemNode[];
}

let deviceExplorerProvider: AsyncTreeProvider;
let luaModulesProvider: AsyncTreeProvider;
let cModulesProvider: AsyncTreeProvider;

function getIniPath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return path.join(folders[0].uri.fsPath, "nodemcu.ini");
}

function getConfigOrNull(): NodemcuConfig | null {
  return cachedConfig;
}

function getFirmwarePath(): string | null {
  if (cachedFirmwarePath) return cachedFirmwarePath;
  const cfg = getConfigOrNull();
  if (!cfg) return null;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  try {
    cachedFirmwarePath = resolveFirmwarePath(folders[0].uri.fsPath, cfg.nodemcu.firmware_path);
    return cachedFirmwarePath;
  } catch {
    return null;
  }
}

function refreshAll(): void {
  deviceExplorerProvider?.refresh();
  luaModulesProvider?.refresh();
  cModulesProvider?.refresh();
}

function setStatus(state: BuildState, text: string, detail?: string): void {
  statusEmitter.update({ state, text, detail });
  statusBarItem.text = `$(circuit-board) ${text}`;
  statusBarItem.tooltip = detail ?? text;
  statusBarItem.show();
}

async function ensureNodemcuTool(python: string): Promise<boolean> {
  const tool = new NodemcuTool(new Shell());
  if (await tool.isInstalled(python)) return true;
  const choice = await vscode.window.showWarningMessage(
    "nodemcu-tool Python package is not installed. Install now?",
    "Install",
    "Cancel",
  );
  if (choice !== "Install") return false;
  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Installing nodemcu-tool..." },
    async () => {
      const r = await tool.install(python, (s) => outputChannel.append(s));
      if (!r.success) {
        vscode.window.showErrorMessage(`Failed to install nodemcu-tool: ${r.error}`);
        return false;
      }
      vscode.window.showInformationMessage("nodemcu-tool installed.");
      return true;
    },
  );
}

async function ensurePort(cfg: NodemcuConfig): Promise<string | null> {
  let port = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("port") ?? cfg.nodemcu.port;
  if (port) return port;
  const discovery = new SerialDiscovery(new Shell());
  const ports = await discovery.list();
  if (ports.length === 0) {
    vscode.window.showErrorMessage("No serial ports detected.");
    return null;
  }
  return await vscode.window.showQuickPick(ports.map((p) => p.path), { placeHolder: "Select serial port" }) ?? null;
}

async function doBuild(): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = getFirmwarePath();
  if (!cfg || !fw) {
    vscode.window.showErrorMessage("No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first.");
    return;
  }
  setStatus("configuring", "configuring...");
  const toolchain = await new ToolchainLocator(new Shell()).locate();
  setStatus("building", "building...");
  const mgr = new BuildManager(new Shell());
  const result = await mgr.build({
    firmwarePath: fw,
    config: cfg,
    parallel: cfg.build.parallel,
    jobCount: os.cpus().length,
    verbose: cfg.build.verbose,
    generator: toolchain.generator,
    onLog: (s) => outputChannel.append(s),
    onStderr: (s) => outputChannel.append(s),
  });
  if (result.success) {
    setStatus("success", "build OK", result.summary);
    vscode.window.showInformationMessage(`Build succeeded in ${result.durationMs}ms: ${result.summary}`);
  } else {
    setStatus("error", "build FAILED", result.summary);
    vscode.window.showErrorMessage(`Build failed: ${result.summary}`);
  }
}

async function doFlash(): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = getFirmwarePath();
  if (!cfg || !fw) {
    vscode.window.showErrorMessage("No nodemcu.ini found. Initialize project first.");
    return;
  }
  const port = await ensurePort(cfg);
  if (!port) return;
  setStatus("flashing", `flashing ${port}...`);
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const mgr = new FlashManager(new Shell());
  const r = await mgr.flash({
    python,
    firmwarePath: fw,
    config: cfg,
    port,
    onLog: (s) => outputChannel.append(s),
    onStderr: (s) => outputChannel.append(s),
  });
  if (r.success) {
    setStatus("success", `flashed ${port}`);
    vscode.window.showInformationMessage(`Flashed ${port} in ${r.durationMs}ms`);
  } else {
    setStatus("error", `flash FAILED`);
    vscode.window.showErrorMessage(`Flash failed (exit ${r.exitCode})`);
  }
}

async function doBuildAndFlash(): Promise<void> {
  await doBuild();
  if (statusEmitter.getState() === "success") await doFlash();
}

async function doInitProject(): Promise<void> {
  const iniPath = getIniPath();
  if (!iniPath) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }
  if (fs.existsSync(iniPath)) {
    const choice = await vscode.window.showWarningMessage(
      "nodemcu.ini already exists. Overwrite?",
      "Overwrite",
      "Cancel",
    );
    if (choice !== "Overwrite") return;
  }
  saveConfig(iniPath, defaultConfig());
  await vscode.window.showTextDocument(vscode.Uri.file(iniPath));
  if (watcher) watcher.stop();
  watcher = new ConfigWatcher(iniPath);
  watcher.onChange((c) => {
    cachedConfig = c;
    cachedFirmwarePath = null;
    refreshAll();
  });
  cachedConfig = loadConfig(iniPath);
  refreshAll();
}

async function pickWorkspaceFile(): Promise<vscode.Uri | null> {
  const picks = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Upload" });
  return picks?.[0] ?? null;
}

async function doUploadFile(uri?: vscode.Uri): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const file = uri ?? (await pickWorkspaceFile());
  if (!file) return;
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const tool = new NodemcuTool(new Shell());
  if (!(await tool.isInstalled(python))) {
    const ok = await ensureNodemcuTool(python);
    if (!ok) return;
  }
  const port = await ensurePort(cfg);
  if (!port) return;
  const remoteName = path.basename(file.fsPath);
  setStatus("uploading", `uploading ${remoteName}...`);
  const r = await tool.upload(
    { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false },
    file.fsPath,
    remoteName,
    (s) => outputChannel.append(s),
  );
  if (r.success) {
    setStatus("success", `uploaded ${remoteName}`);
    vscode.window.showInformationMessage(`Uploaded ${remoteName}`);
  } else {
    setStatus("error", `upload FAILED`);
    vscode.window.showErrorMessage(`Upload failed: ${r.error}`);
  }
}

async function doSyncLuaModules(): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = getFirmwarePath();
  if (!cfg || !fw) return;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return;
  const workspaceRoot = folders[0].uri.fsPath;
  const resolved = await resolveAllLuaModules(workspaceRoot, fw, cfg);
  const local = resolved.filter((m) => !m.isRemote && m.exists);
  if (local.length === 0) {
    vscode.window.showInformationMessage("No local Lua modules to sync.");
    return;
  }
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const tool = new NodemcuTool(new Shell());
  if (!(await tool.isInstalled(python))) {
    const ok = await ensureNodemcuTool(python);
    if (!ok) return;
  }
  const port = await ensurePort(cfg);
  if (!port) return;
  for (const m of local) {
    setStatus("uploading", `uploading ${m.name}...`);
    const r = await tool.upload(
      { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: true },
      m.resolvedLocalPath!,
      m.name + ".lc",
      (s) => outputChannel.append(s),
    );
    if (!r.success) {
      vscode.window.showErrorMessage(`Failed to upload ${m.name}: ${r.error}`);
    }
  }
  setStatus("success", `synced ${local.length} module(s)`);
}

async function doRegenerateLuaApi(): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = getFirmwarePath();
  if (!cfg || !fw) return;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return;
  const workspaceRoot = folders[0].uri.fsPath;
  const modules = Object.entries(cfg.c_modules).filter(([_, v]) => v).map(([k]) => k);
  const apiPath = path.join(workspaceRoot, ".vscode", "nodemcu-api.lua");
  generateLuaApiFile({ modules, outputPath: apiPath });
  const luaDirs = [luaModulesDir(fw), path.join(workspaceRoot, "lua")];
  writeLuaRc({ workspaceRoot, luaModulesDirs: luaDirs, apiFile: apiPath });
  vscode.window.showInformationMessage(`Generated ${apiPath}`);
}

async function doAddLuaModule(item?: { module: LuaModuleInfo }): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = getFirmwarePath();
  if (!cfg || !fw) return;
  const modules = item ? [item.module] : await listLuaModulesFromFirmware(fw);
  if (modules.length === 0) {
    vscode.window.showInformationMessage("No Lua modules found in firmware/lua_modules/.");
    return;
  }
  type PickerItem = { label: string; description: string; module: LuaModuleInfo };
  let pick: PickerItem | undefined;
  if (item?.module) {
    pick = { label: item.module.name, description: item.module.description, module: item.module };
  } else {
    pick = await vscode.window.showQuickPick<PickerItem>(
      modules.map((m) => ({ label: m.name, description: m.description, module: m })),
      { placeHolder: "Select Lua module" },
    );
  }
  if (!pick) return;
  const newCfg = setLuaModule(cfg, pick.label, `lua_modules/${pick.label}/${path.basename(pick.module.mainFile)}`);
  const iniPath = getIniPath();
  if (iniPath) saveConfig(iniPath, newCfg);
}

async function doToggleCModule(item?: { module: CModuleInfo }): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const fw = getFirmwarePath();
  if (!fw) return;
  type CModulePickerItem = { label: string; description: "core" | "optional" | "library"; module: CModuleInfo };
  let modulePick: CModulePickerItem | undefined;
  if (item?.module) {
    modulePick = { label: item.module.name, description: item.module.category, module: item.module };
  } else {
    modulePick = await vscode.window.showQuickPick<CModulePickerItem>(
      (await listCModules(fw)).map((m) => ({ label: m.name, description: m.category, module: m })),
      { placeHolder: "Toggle C module" },
    );
  }
  if (!modulePick) return;
  const currently = cfg.c_modules[modulePick.label] ?? false;
  const newCfg = setCModule(cfg, modulePick.label, !currently);
  const iniPath = getIniPath();
  if (iniPath) saveConfig(iniPath, newCfg);
}

function doRefreshExplorer(): void {
  deviceExplorerProvider?.refresh();
}

function doOpenIni(): void {
  const iniPath = getIniPath();
  if (!iniPath) return;
  vscode.window.showTextDocument(vscode.Uri.file(iniPath));
}

async function doOpenSerialMonitor(): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const port = await ensurePort(cfg);
  if (!port) return;
  const term = vscode.window.createTerminal({ name: `NodeMCU: ${port}`, shellPath: "python" });
  term.show();
  const baud = cfg.nodemcu.baud;
  const args = ["-c", `import serial, sys; s=serial.Serial('${port}', ${baud}); [sys.stdout.write(l.decode(errors='ignore')) for l in iter(s.readline, b'')]`];
  term.sendText(`python ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`);
}

function buildDeviceExplorerProvider(): AsyncTreeProvider {
  return new AsyncTreeProvider(async () => {
    const cfg = getConfigOrNull();
    const port = cfg?.nodemcu.port ?? "(not configured)";
    return [
      {
        id: "device-root",
        label: `NodeMCU (${port})`,
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        contextValue: "nodemcu.deviceRoot",
        iconPath: new vscode.ThemeIcon("circuit-board"),
        children: [
          {
            id: "device-info",
            label: cfg ? "Click 'Refresh' to connect" : "Initialize a project first",
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            contextValue: "nodemcu.deviceInfo",
            iconPath: new vscode.ThemeIcon("info"),
          },
        ],
      },
    ];
  });
}

function buildLuaModulesProvider(): AsyncTreeProvider {
  return new AsyncTreeProvider(async () => {
    const fw = getFirmwarePath();
    if (!fw) return [];
    const mods = await listLuaModulesFromFirmware(fw);
    return mods.map((m) => ({
      id: `lua-module-${m.name}`,
      label: m.name,
      description: m.description,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: "nodemcu.luaModule",
      iconPath: new vscode.ThemeIcon("library"),
      command: {
        command: "vscode.open",
        title: "Open",
        arguments: [vscode.Uri.file(m.mainFile)],
      },
    }));
  });
}

function buildCModulesProvider(): AsyncTreeProvider {
  return new AsyncTreeProvider(async () => {
    const cfg = getConfigOrNull();
    const fw = getFirmwarePath();
    if (!fw) return [];
    const mods = await listCModules(fw);
    return mods.map((m) => {
      const enabled = cfg?.c_modules[m.name] ?? false;
      return {
        id: `c-module-${m.name}`,
        label: m.name,
        description: `${m.category}${enabled ? "  ✓ enabled" : ""}`,
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        contextValue: "nodemcu.cModule",
        iconPath: new vscode.ThemeIcon(enabled ? "check" : "circle-outline"),
      };
    });
  });
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("NodeMCU");
  statusEmitter = new StatusEmitter();
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "nodemcu-vscode.openIni";
  context.subscriptions.push(statusBarItem, outputChannel);
  setStatus("idle", "NodeMCU: idle");

  deviceExplorerProvider = buildDeviceExplorerProvider();
  luaModulesProvider = buildLuaModulesProvider();
  cModulesProvider = buildCModulesProvider();
  void deviceExplorerProvider.reload();
  void luaModulesProvider.reload();
  void cModulesProvider.reload();
  vscode.window.registerTreeDataProvider("nodemcu.deviceExplorer", deviceExplorerProvider);
  vscode.window.registerTreeDataProvider("nodemcu.luaModules", luaModulesProvider);
  vscode.window.registerTreeDataProvider("nodemcu.cModules", cModulesProvider);

  const iniPath = getIniPath();
  if (iniPath && fs.existsSync(iniPath)) {
    watcher = new ConfigWatcher(iniPath);
    watcher.onChange((c) => {
      cachedConfig = c;
      cachedFirmwarePath = null;
      refreshAll();
    });
    cachedConfig = watcher.current();
    watcher.start();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("nodemcu-vscode.initProject", doInitProject),
    vscode.commands.registerCommand("nodemcu-vscode.build", doBuild),
    vscode.commands.registerCommand("nodemcu-vscode.flash", doFlash),
    vscode.commands.registerCommand("nodemcu-vscode.buildAndFlash", doBuildAndFlash),
    vscode.commands.registerCommand("nodemcu-vscode.uploadFile", doUploadFile),
    vscode.commands.registerCommand("nodemcu-vscode.syncLuaModules", doSyncLuaModules),
    vscode.commands.registerCommand("nodemcu-vscode.regenerateLuaApi", doRegenerateLuaApi),
    vscode.commands.registerCommand("nodemcu-vscode.addLuaModule", doAddLuaModule),
    vscode.commands.registerCommand("nodemcu-vscode.toggleCModule", doToggleCModule),
    vscode.commands.registerCommand("nodemcu-vscode.refreshExplorer", doRefreshExplorer),
    vscode.commands.registerCommand("nodemcu-vscode.openIni", doOpenIni),
    vscode.commands.registerCommand("nodemcu-vscode.openSerialMonitor", doOpenSerialMonitor),
  );
}

export function deactivate(): void {
  watcher?.stop();
}
