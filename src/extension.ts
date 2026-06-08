import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { Shell } from "./util/shell";
import { OperationGate } from "./util/operationGate";
import {
  defaultConfig,
  loadConfig,
  parseIni,
  saveConfig,
  addDeviceUuid,
  hasDeviceUuid,
  setCModule,
  setLuaModule,
  type NodemcuConfig,
} from "./config/nodemcuIni";
import { IniCompletionItemProvider } from "./config/iniCompletion";
import { ConfigWatcher } from "./config/configWatcher";
import { resolveFirmwarePath, luaModulesDir, userModulesHeader } from "./util/paths";
import { isCModulesConfigChanged, writeUserModulesHeader } from "./build/userModulesWriter";
import { BuildManager } from "./build/buildManager";
import { ToolchainLocator } from "./build/toolchain";
import { FlashManager } from "./flash/flashManager";
import { chooseAutoPort } from "./flash/autoPort";
import { SerialDiscovery, type SerialPort } from "./flash/serialDiscovery";
import { NodemcuTool, type FileEntry, type NodemcuToolOptions } from "./upload/nodemcuTool";
import { DirectSerialUploader } from "./upload/directSerialUploader";
import { readDeviceIdentity, type DeviceIdentity } from "./device/deviceIdentity";
import { planMirrorSync } from "./upload/srcMirror";
import { StatusEmitter, type BuildState } from "./status/statusBar";
import { listLuaModulesFromFirmware, listCModules, type LuaModuleInfo, type CModuleInfo } from "./luaPicker/moduleList";
import { createLuaModuleCompletionItem } from "./luaPicker/luaModuleCompletion";
import { resolveAllLuaModules } from "./luaPicker/luaModuleResolver";
import { generateLuaApiFile, writeLuaRc } from "./luaApi/apiFiles";
import { ensureManagedFirmware } from "./firmware/managedFirmware";

let outputChannel: vscode.OutputChannel;
let statusEmitter: StatusEmitter;
let statusBarItem: vscode.StatusBarItem;
let portStatusBarItem: vscode.StatusBarItem;
let watcher: ConfigWatcher | undefined;
let cachedConfig: NodemcuConfig | null = null;
let cachedFirmwarePath: string | null = null;
let pendingFirmwarePromise: Promise<string | null> | null = null;
let extensionContext: vscode.ExtensionContext;

export class AsyncTreeProvider implements vscode.TreeDataProvider<TreeItemNode> {
  private _onDidChange = new vscode.EventEmitter<TreeItemNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private cache: TreeItemNode[] = [];
  private pendingReload: Promise<void> | null = null;
  private reloadAgain = false;

  constructor(private loader: () => Promise<TreeItemNode[]>) {}

  refresh(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    if (this.pendingReload) {
      this.reloadAgain = true;
      return this.pendingReload;
    }

    this.pendingReload = this.runReloadLoop();
    try {
      await this.pendingReload;
    } finally {
      this.pendingReload = null;
    }
  }

  private async runReloadLoop(): Promise<void> {
    do {
      this.reloadAgain = false;
      try {
        this.cache = await this.loader();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.cache = [{
          id: "load-error",
          label: "Unable to load",
          description: message,
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          iconPath: new vscode.ThemeIcon("error"),
        }];
        outputChannel?.appendLine(`Tree load failed: ${message}`);
      }
      this._onDidChange.fire(undefined);
    } while (this.reloadAgain);
  }

  getTreeItem(el: TreeItemNode): vscode.TreeItem {
    const item = new vscode.TreeItem(el.label, el.collapsibleState);
    if (el.description) item.description = el.description;
    if (el.contextValue) item.contextValue = el.contextValue;
    if (el.iconPath) item.iconPath = el.iconPath;
    if (el.command) item.command = el.command;
    if (el.resourceUri) item.resourceUri = el.resourceUri;
    if (el.checkboxState !== undefined) item.checkboxState = el.checkboxState;
    return item;
  }

  getChildren(el?: TreeItemNode): TreeItemNode[] {
    if (!el) return this.cache;
    return el.children ?? [];
  }
}

export interface TreeItemNode {
  id: string;
  label: string;
  description?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  contextValue?: string;
  iconPath?: vscode.ThemeIcon;
  command?: vscode.Command;
  resourceUri?: vscode.Uri;
  children?: TreeItemNode[];
  checkboxState?: vscode.TreeItemCheckboxState;
  luaModule?: LuaModuleInfo;
  cModule?: CModuleInfo;
  serialPort?: SerialPort;
  remoteFile?: FileEntry;
}

let deviceExplorerProvider: AsyncTreeProvider;
let luaModulesProvider: AsyncTreeProvider;
let cModulesProvider: AsyncTreeProvider;
let portRefreshTimer: NodeJS.Timeout | undefined;
let operationGate: OperationGate;
let projectTasksProvider: AsyncTreeProvider;
let srcSaveTimer: NodeJS.Timeout | undefined;
let lastSavedUri: vscode.Uri | undefined;

export interface ClosedSerialMonitor {
  name: string;
  port: string;
}

function existingIniPath(): string | null {
  const iniPath = getIniPath();
  return iniPath && fs.existsSync(iniPath) ? iniPath : null;
}

function getIniPath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  for (const folder of folders) {
    const candidate = path.join(folder.uri.fsPath, "nodemcu.ini");
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const folder of folders) {
    try {
      const entries = fs.readdirSync(folder.uri.fsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(folder.uri.fsPath, entry.name, "nodemcu.ini");
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // Ignore folders VS Code can see but Node cannot enumerate.
    }
  }
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activeFile) {
    let dir = activeFile;
    try {
      dir = fs.statSync(activeFile).isDirectory() ? activeFile : path.dirname(activeFile);
    } catch {
      dir = path.dirname(activeFile);
    }
    while (true) {
      const candidate = path.join(dir, "nodemcu.ini");
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.join(folders[0].uri.fsPath, "nodemcu.ini");
}

function getConfigOrNull(): NodemcuConfig | null {
  if (!cachedConfig) {
    const iniPath = existingIniPath();
    if (iniPath) cachedConfig = loadConfig(iniPath);
  }
  return cachedConfig;
}

function getWorkspaceRoot(): string | null {
  const iniPath = getIniPath();
  if (iniPath && fs.existsSync(iniPath)) return path.dirname(iniPath);
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath ?? null;
}

async function getFirmwarePath(): Promise<string | null> {
  if (cachedFirmwarePath) return cachedFirmwarePath;
  if (pendingFirmwarePromise) return pendingFirmwarePromise;

  const cfg = getConfigOrNull();
  const configuredSetting = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("firmwarePath");
  const configuredIni = cfg?.nodemcu.firmware_path ?? "";
  const configured = configuredSetting || configuredIni;
  if (configured.trim()) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot && !path.isAbsolute(configured)) return null;
    try {
      cachedFirmwarePath = resolveFirmwarePath(workspaceRoot ?? process.cwd(), configured);
      return cachedFirmwarePath;
    } catch {
      return null;
    }
  }

  pendingFirmwarePromise = (async () => {
    try {
      const fwPath = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "NodeMCU firmware", cancellable: false },
        async (progress) => ensureManagedFirmware({
          storageRoot: extensionContext.globalStorageUri.fsPath,
          onProgress: (message) => progress.report({ message }),
        }),
      );
      cachedFirmwarePath = fwPath;
      refreshAll();
      return fwPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel?.appendLine(`Managed firmware failed: ${message}`);
      vscode.window.showErrorMessage(`Failed to prepare managed NodeMCU firmware: ${message}`);
      return null;
    } finally {
      pendingFirmwarePromise = null;
    }
  })();

  return pendingFirmwarePromise;
}

function refreshAll(): void {
  deviceExplorerProvider?.refresh();
  luaModulesProvider?.refresh();
  cModulesProvider?.refresh();
  projectTasksProvider?.refresh();
  updateProjectContext();
}

function isProjectValid(): boolean {
  const iniPath = existingIniPath();
  if (!iniPath) return false;
  const cfg = getConfigOrNull();
  const srcSetting = cfg?.nodemcu.src || vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("src") || "src";
  const srcDir = path.resolve(path.dirname(iniPath), srcSetting);
  try {
    return fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory();
  } catch {
    return false;
  }
}

function updateProjectContext(): void {
  void vscode.commands.executeCommand("setContext", "nodemcu.projectValid", isProjectValid());
}

function setStatus(state: BuildState, text: string, detail?: string): void {
  statusEmitter.update({ state, text, detail });
  statusBarItem.text = `$(circuit-board) ${text}`;
  statusBarItem.tooltip = detail ?? text;
  statusBarItem.show();
  if (state !== "idle") {
    outputChannel?.appendLine(`[${new Date().toLocaleTimeString()}] ${text}${detail ? ` - ${detail}` : ""}`);
  }
}

function showOperationLog(name: string): void {
  outputChannel.show(true);
  outputChannel.appendLine(`\n[${new Date().toISOString()}] Starting ${name}`);
}

function commandWithOperation<T extends unknown[]>(
  name: string,
  fn: (signal: AbortSignal, ...args: T) => Promise<void> | void,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    showOperationLog(name);
    await operationGate.run(name, async (signal) => {
      await fn(signal, ...args);
    });
  };
}

function availableConfiguredPort(ports: SerialPort[], cfg: NodemcuConfig | null, settingsPort = ""): string {
  const configured = settingsPort || cfg?.nodemcu.port || "";
  return configured && ports.some((port) => port.path.toLowerCase() === configured.toLowerCase()) ? configured : "";
}

async function updatePortStatusBar(cfg: NodemcuConfig | null) {
  if (!portStatusBarItem) return;
  try {
    const ports = await new SerialDiscovery(new Shell()).list();
    const settingPort = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("port") || "";
    const selection = chooseAutoPort(ports, cfg, settingPort);
    const selectedPort = selection?.port || availableConfiguredPort(ports, cfg, settingPort);
    if (!selectedPort) {
      portStatusBarItem.text = ports.length > 0 ? `$(plug) ${ports.length} Ports` : `$(plug) No Port`;
      portStatusBarItem.tooltip = "Click to select a serial port";
      portStatusBarItem.show();
      return;
    }
    const port = ports.find((p) => p.path === selectedPort);
    const name = port?.manufacturer ? ` (${port.manufacturer})` : "";
    portStatusBarItem.text = `$(plug) ${selectedPort}${name}`;
  } catch {
    const fallback = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("port") || cfg?.nodemcu.port || "No Port";
    portStatusBarItem.text = `$(plug) ${fallback}`;
  }
  portStatusBarItem.tooltip = "Click to select a serial port";
  portStatusBarItem.show();
}

async function refreshDetectedPortsAndMaybeSelect(): Promise<string | null> {
  const cfg = getConfigOrNull();
  const ports = await new SerialDiscovery(new Shell()).list();
  const settingPort = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("port") || "";
  const selection = chooseAutoPort(ports, cfg, settingPort);
  if (selection?.shouldSave && cfg) {
    cfg.nodemcu.port = selection.port;
    cachedConfig = cfg;
    const iniPath = existingIniPath();
    if (iniPath) saveConfig(iniPath, cfg);
  }
  updatePortStatusBar(cachedConfig);
  deviceExplorerProvider?.refresh();
  return selection?.port ?? null;
}

async function ensureNodemcuTool(python: string): Promise<boolean> {
  const tool = new NodemcuTool(new Shell());
  if (await tool.isInstalled(python)) return true;
  const choice = await vscode.window.showWarningMessage(
    "nodemcu-tool is not installed. Install the npm package now?",
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
  const discovery = new SerialDiscovery(new Shell());
  const ports = await discovery.list();
  const settingPort = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("port") || "";
  const selection = chooseAutoPort(ports, cfg, settingPort);
  if (selection) {
    if (selection.shouldSave) {
      cfg.nodemcu.port = selection.port;
      cachedConfig = cfg;
      const iniPath = existingIniPath();
      if (iniPath) saveConfig(iniPath, cfg);
    }
    updatePortStatusBar(cfg);
    deviceExplorerProvider?.refresh();
    return selection.port;
  }
  if (settingPort || cfg.nodemcu.port) {
    const configured = settingPort || cfg.nodemcu.port;
    const choice = await vscode.window.showWarningMessage(
      `Configured serial port ${configured} is not available.`,
      "Select Port",
      "Cancel",
    );
    if (choice !== "Select Port") return null;
  }
  return await doSelectPort();
}

function saveSelectedPort(port: string): void {
  const iniPath = existingIniPath();
  const cfg = getConfigOrNull();
  if (iniPath && cfg) {
    cfg.nodemcu.port = port;
    cachedConfig = cfg;
    saveConfig(iniPath, cfg);
    updatePortStatusBar(cfg);
    refreshAll();
  }
}

async function doSelectPort(item?: { serialPort?: SerialPort } | SerialPort): Promise<string | null> {
  outputChannel.show(true);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Selecting serial port...`);
  const directPort = "serialPort" in (item ?? {}) ? (item as { serialPort?: SerialPort }).serialPort?.path : (item as SerialPort | undefined)?.path;
  if (directPort) {
    saveSelectedPort(directPort);
    return directPort;
  }
  const discovery = new SerialDiscovery(new Shell());
  const ports = await discovery.list();
  if (ports.length === 0) {
    vscode.window.showErrorMessage("No serial ports detected.");
    return null;
  }
  
  const items = ports.map((p) => ({
    label: p.path,
    description: p.manufacturer ? `(${p.manufacturer})` : "",
  }));
  
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Select serial port" });
  if (!pick) return null;
  
  saveSelectedPort(pick.label);
  return pick.label;
}

async function doBuild(signal?: AbortSignal): Promise<void> {
  const logFile = "c:\\Users\\caioh\\src\\vscode\\nodemcu-vscode\\build_debug.log";
  const log = (msg: string) => {
    try {
      require("node:fs").appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
    } catch {}
  };
  log("doBuild called");
  const iniPath = getIniPath();
  log(`getIniPath: ${iniPath}`);
  const cfg = getConfigOrNull();
  log(`getConfigOrNull: ${JSON.stringify(cfg)}`);
  const fw = await getFirmwarePath();
  log(`getFirmwarePath: ${fw}`);
  if (!cfg) {
    vscode.window.showErrorMessage("No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first.");
    return;
  }
  if (!fw) {
    vscode.window.showErrorMessage("NodeMCU firmware is unavailable. Check the managed firmware download or any custom firmware_path override.");
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
    signal,
  });
  if (result.success) {
    setStatus("success", "build OK", result.summary);
    vscode.window.showInformationMessage(`Build succeeded in ${result.durationMs}ms: ${result.summary}`);
  } else {
    setStatus("error", "build FAILED", result.summary);
    vscode.window.showErrorMessage(`Build failed: ${result.summary}`);
  }
}

async function doFlash(signal?: AbortSignal): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) {
    vscode.window.showErrorMessage("No nodemcu.ini found. Initialize project first.");
    return;
  }
  const fw = await getFirmwarePath();
  if (!fw) {
    vscode.window.showErrorMessage("NodeMCU firmware is unavailable. Check the managed firmware download or any custom firmware_path override.");
    return;
  }
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  const identity = await ensureKnownDevice(cfg, port, signal);
  if (!identity.allowed) return;
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
    signal,
  });
  if (r.success) {
    setStatus("success", `flashed ${port}`);
    vscode.window.showInformationMessage(`Flashed ${port} in ${r.durationMs}ms`);
    if (identity.isNew) {
      await mirrorSrcToDevice({ changedOnly: false, forceFormat: true, signal });
    }
  } else {
    setStatus("error", `flash FAILED`);
    vscode.window.showErrorMessage(`Flash failed (exit ${r.exitCode})`);
  }
}

async function doBuildAndFlash(signal?: AbortSignal): Promise<void> {
  await doBuild(signal);
  if (statusEmitter.getState() === "success" && !signal?.aborted) await doFlash(signal);
}

async function doInitProject(): Promise<void> {
  outputChannel.show(true);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Initializing NodeMCU project...`);
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
  const templatePath = extensionContext
    ? path.join(extensionContext.extensionPath, "resources", "templates", "nodemcu.ini")
    : path.join(__dirname, "..", "resources", "templates", "nodemcu.ini");
  const initialConfig = fs.existsSync(templatePath)
    ? parseIni(fs.readFileSync(templatePath, "utf-8"))
    : defaultConfig();
  saveConfig(iniPath, initialConfig);

  const srcDir = path.join(path.dirname(iniPath), "src");
  if (!fs.existsSync(srcDir)) {
    fs.mkdirSync(srcDir, { recursive: true });
  }

  const initLuaPath = path.join(srcDir, "init.lua");
  if (!fs.existsSync(initLuaPath)) {
    fs.writeFileSync(
      initLuaPath,
      'print("Hello World from NodeMCU!")\n\n-- Example WiFi configuration\n-- wifi.setmode(wifi.STATION)\n-- wifi.sta.config({ssid="your_ssid", pwd="your_password"})\n',
      "utf8",
    );
  }

  await vscode.window.showTextDocument(vscode.Uri.file(iniPath));
  if (watcher) watcher.stop();
  watcher = new ConfigWatcher(iniPath);
  watcher.onChange((c) => {
    cachedConfig = c;
    cachedFirmwarePath = null;
    refreshAll();
    updatePortStatusBar(c);
  });
  cachedConfig = loadConfig(iniPath);
  watcher.start();
  refreshAll();
  updatePortStatusBar(cachedConfig);
}

function isFilesystemError(error: string | undefined): boolean {
  return !!error && (error.includes("unable to open file") || error.includes("index global 'file'"));
}

function shouldUseNodemcuToolFallback(error: string | undefined): boolean {
  if (!error) return true;
  const e = error.toLowerCase();
  return !e.includes("operation cancelled") && !e.includes("unsafe remote file name");
}

async function nodemcuToolFallback(python: string, promptInstall = true): Promise<NodemcuTool | null> {
  const tool = new NodemcuTool(new Shell());
  if (await tool.isInstalled(python)) return tool;
  if (!promptInstall) return null;
  return await ensureNodemcuTool(python) ? tool : null;
}

async function uploadWithFallback(
  opts: NodemcuToolOptions,
  localPath: string,
  remoteName: string,
): Promise<{ success: boolean; error?: string }> {
  const direct = new DirectSerialUploader();
  const directResult = await direct.upload(opts, localPath, remoteName, (s) => outputChannel.append(s));
  if (directResult.success || !shouldUseNodemcuToolFallback(directResult.error)) return directResult;

  outputChannel.appendLine(`\nDirect serial upload failed (${directResult.error}). Retrying with nodemcu-tool...`);
  const tool = await nodemcuToolFallback(opts.python);
  if (!tool) return directResult;
  let r = await tool.upload(opts, localPath, remoteName, (s) => outputChannel.append(s));

  if (!r.success && isFilesystemError(r.error)) {
    outputChannel.appendLine(`\nDevice filesystem may be unformatted. Formatting automatically...`);
    const mkfsRes = await tool.mkfs(opts, (s) => outputChannel.append(s));
    if (mkfsRes.success) {
      outputChannel.appendLine(`\nFormat successful. Retrying upload...`);
      r = await tool.upload(opts, localPath, remoteName, (s) => outputChannel.append(s));
    } else {
      outputChannel.appendLine(`\nFormat failed: ${mkfsRes.error}`);
    }
  }

  return r;
}

async function listFilesWithFallback(opts: NodemcuToolOptions, promptInstall = true): Promise<{ success: boolean; files?: FileEntry[]; error?: string }> {
  const direct = new DirectSerialUploader();
  const directResult = await direct.listFiles(opts, (s) => outputChannel.append(s));
  if (directResult.success || !shouldUseNodemcuToolFallback(directResult.error)) return directResult;

  outputChannel.appendLine(`\nDirect serial file listing failed (${directResult.error}). Retrying with nodemcu-tool...`);
  const tool = await nodemcuToolFallback(opts.python, promptInstall);
  if (!tool) return directResult;
  return await tool.listFilesResult(opts, (s) => outputChannel.append(s));
}

async function removeWithFallback(opts: NodemcuToolOptions, remoteName: string): Promise<{ success: boolean; error?: string }> {
  const direct = new DirectSerialUploader();
  const directResult = await direct.remove(opts, remoteName, (s) => outputChannel.append(s));
  if (directResult.success || !shouldUseNodemcuToolFallback(directResult.error)) return directResult;

  outputChannel.appendLine(`\nDirect serial delete failed (${directResult.error}). Retrying with nodemcu-tool...`);
  const tool = await nodemcuToolFallback(opts.python);
  if (!tool) return directResult;
  return await tool.remove(opts, remoteName, (s) => outputChannel.append(s));
}

async function runFileWithFallback(opts: NodemcuToolOptions, remoteName: string): Promise<{ success: boolean; error?: string }> {
  const direct = new DirectSerialUploader();
  const directResult = await direct.runFile(opts, remoteName, (s) => outputChannel.append(s));
  if (directResult.success || !shouldUseNodemcuToolFallback(directResult.error)) return directResult;

  outputChannel.appendLine(`\nDirect serial run failed (${directResult.error}). Retrying with nodemcu-tool...`);
  const tool = await nodemcuToolFallback(opts.python);
  if (!tool) return directResult;
  return await tool.runFile(opts, remoteName, (s) => outputChannel.append(s));
}

async function resetWithFallback(opts: NodemcuToolOptions): Promise<{ success: boolean; error?: string }> {
  const direct = new DirectSerialUploader();
  const directReset = await direct.hardReset(opts, (s) => outputChannel.append(s));
  if (directReset.success) return { success: true };
  outputChannel.appendLine(`Direct serial reset failed (${directReset.error}). Retrying with nodemcu-tool reset...`);
  if (!shouldUseNodemcuToolFallback(directReset.error)) return directReset;
  const tool = await nodemcuToolFallback(opts.python);
  if (!tool) return directReset;
  const r = await tool.reset(opts, (s) => outputChannel.append(s));
  if (r.success) return { success: true };
  outputChannel.appendLine(`Reset via nodemcu-tool failed: ${r.error}`);
  return r;
}

async function formatWithFallback(opts: NodemcuToolOptions): Promise<{ success: boolean; error?: string }> {
  const tool = await nodemcuToolFallback(opts.python);
  if (!tool) return { success: false, error: "nodemcu-tool is unavailable for filesystem format" };
  return await tool.mkfs(opts, (s) => outputChannel.append(s));
}

async function ensureKnownDevice(cfg: NodemcuConfig, port: string, signal?: AbortSignal): Promise<{ allowed: boolean; identity?: DeviceIdentity; isNew: boolean }> {
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const result = await readDeviceIdentity({ shell: new Shell(), python, port, baud: cfg.nodemcu.baud, signal });
  if (!result.success || !result.identity) {
    vscode.window.showErrorMessage(`Unable to identify attached NodeMCU device: ${result.error}`);
    return { allowed: false, isNew: false };
  }
  if (hasDeviceUuid(cfg, result.identity.uuid)) {
    return { allowed: true, identity: result.identity, isNew: false };
  }

  const choice = await vscode.window.showWarningMessage(
    `Device ${result.identity.macAddress} is not listed in nodemcu.ini for this workspace. Proceeding will add it, format the device filesystem, and sync files from src/.`,
    "Proceed",
    "Cancel",
  );
  if (choice !== "Proceed") {
    vscode.window.showWarningMessage("Open the workspace that matches this device, or proceed after confirming this workspace should own it.");
    return { allowed: false, identity: result.identity, isNew: true };
  }

  const iniPath = existingIniPath();
  if (iniPath) {
    const next = addDeviceUuid(cfg, result.identity.uuid);
    cachedConfig = next;
    saveConfig(iniPath, next);
    refreshAll();
  }
  return { allowed: true, identity: result.identity, isNew: true };
}

function getConfiguredSrcDir(cfg: NodemcuConfig): string | null {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return null;
  const srcSetting = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("src") || cfg.nodemcu.src || "src";
  return path.resolve(workspaceRoot, srcSetting);
}

function isUriUnderSrc(uri: vscode.Uri, cfg: NodemcuConfig): boolean {
  if (uri.scheme !== "file") return false;
  const srcDir = getConfiguredSrcDir(cfg);
  if (!srcDir) return false;
  const rel = path.relative(srcDir, uri.fsPath);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function mirrorSrcToDevice(opts: { changedOnly: boolean; forceFormat?: boolean; signal?: AbortSignal }): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) {
    return;
  }
  const srcDir = getConfiguredSrcDir(cfg);
  if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    vscode.window.showWarningMessage("This workspace is not a valid NodeMCU project. Run 'NodeMCU: Initialize Project' first.");
    updateProjectContext();
    return;
  }
  outputChannel.show(true);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Mirroring src/ to device...`);

  const fw = await getFirmwarePath();
  if (fw) {
    const headerPath = userModulesHeader(fw);
    if (isCModulesConfigChanged(headerPath, cfg)) {
      outputChannel.appendLine("C modules configuration has changed. Rebuilding and flashing firmware first...");
      await doBuildAndFlash(opts.signal);
      if (statusEmitter.getState() !== "success") {
        vscode.window.showErrorMessage("Build and flash failed. Sync aborted.");
        return;
      }
    }
  }

  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  const identity = await ensureKnownDevice(cfg, port, opts.signal);
  if (!identity.allowed) return;

  const toolOpts = { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false, signal: opts.signal };
  if (opts.forceFormat || identity.isNew) {
    setStatus("uploading", `formatting ${port}...`);
    const formatted = await formatWithFallback(toolOpts);
    if (!formatted.success) {
      setStatus("error", "format FAILED");
      vscode.window.showErrorMessage(`Device filesystem format failed: ${formatted.error}`);
      return;
    }
  }

  const remote = await listFilesWithFallback(toolOpts, false);
  if (!remote.success) {
    setStatus("error", "sync FAILED");
    vscode.window.showErrorMessage(`Unable to list device files before sync: ${remote.error}`);
    return;
  }

  const uploadTimestamps = extensionContext
    ? extensionContext.workspaceState.get<Record<string, number>>("nodemcu.uploadTimestamps") || {}
    : {};
  const plan = planMirrorSync({
    srcDir,
    remoteFiles: remote.files ?? [],
    uploadTimestamps,
    changedOnly: opts.changedOnly && !opts.forceFormat && !identity.isNew,
  });

  if (plan.upload.length === 0 && plan.remove.length === 0) {
    outputChannel.appendLine("Workspace src/ is already in sync with the device.");
    return;
  }

  setStatus("uploading", `syncing ${plan.upload.length} upload(s), ${plan.remove.length} delete(s)...`);
  let successCount = 0;
  let failCount = 0;

  for (const remoteName of plan.remove) {
    const removed = await removeWithFallback(toolOpts, remoteName);
    if (removed.success) {
      successCount++;
      continue;
    }
    failCount++;
    outputChannel.appendLine(`Failed to remove ${remoteName}: ${removed.error}`);
  }

  for (const file of plan.upload) {
    if (!fs.existsSync(file.localPath)) continue;
    const uploaded = await uploadWithFallback(toolOpts, file.localPath, file.remoteName);
    if (uploaded.success) {
      successCount++;
      uploadTimestamps[file.localPath] = fs.statSync(file.localPath).mtimeMs;
      continue;
    }
    failCount++;
    outputChannel.appendLine(`Failed to upload ${file.remoteName}: ${uploaded.error}`);
  }

  if (extensionContext) {
    await extensionContext.workspaceState.update("nodemcu.uploadTimestamps", uploadTimestamps);
  }

  if (successCount > 0) {
    await resetWithFallback(toolOpts);
  }
  if (failCount > 0) {
    setStatus("error", `sync FAILED (${failCount} errors)`);
    vscode.window.showErrorMessage(`Synced ${successCount} operation(s), ${failCount} failed.`);
  } else if (successCount > 0) {
    updateSyncTimestamp();
    setStatus("success", `synced ${successCount} operation(s)`);
    vscode.window.showInformationMessage(`Synchronized src/ with ${port}.`);
  }
}

function updateSyncTimestamp(): void {
  const iniPath = existingIniPath();
  if (!iniPath) return;
  const cfg = getConfigOrNull();
  if (!cfg) return;
  cfg.sync.last_timestamp = new Date().toISOString();
  cachedConfig = cfg;
  saveConfig(iniPath, cfg);
}

async function doUploadSingleFile(uri: vscode.Uri, cfg: NodemcuConfig, signal?: AbortSignal): Promise<void> {
  const srcDir = getConfiguredSrcDir(cfg);
  if (!srcDir) return;

  outputChannel.show(true);
  const remoteName = path.relative(srcDir, uri.fsPath).replace(/\\/g, "/");
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Uploading ${remoteName}...`);

  const fw = await getFirmwarePath();
  if (fw) {
    const headerPath = userModulesHeader(fw);
    if (isCModulesConfigChanged(headerPath, cfg)) {
      await doBuildAndFlash(signal);
      if (statusEmitter.getState() !== "success") return;
    }
  }

  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  const identity = await ensureKnownDevice(cfg, port, signal);
  if (!identity.allowed) return;

  const toolOpts = { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false, signal };

  setStatus("uploading", `uploading ${remoteName}...`);
  const result = await uploadWithFallback(toolOpts, uri.fsPath, remoteName);

  if (result.success) {
    updateSyncTimestamp();
    setStatus("success", `uploaded ${remoteName}`);
    outputChannel.appendLine(`Uploaded ${remoteName}`);
  } else {
    setStatus("error", `upload FAILED: ${remoteName}`);
    outputChannel.appendLine(`Failed to upload ${remoteName}: ${result.error}`);
  }
}

async function handleFileDelete(event: vscode.FileDeleteEvent): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  if (!cfg.sync.last_timestamp) return;

  const srcDir = getConfiguredSrcDir(cfg);
  if (!srcDir) return;

  outputChannel.show(true);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Handling file deletion...`);

  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  const identity = await ensureKnownDevice(cfg, port);
  if (!identity.allowed) return;

  const toolOpts = { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false };

  for (const uri of event.files) {
    if (uri.scheme !== "file") continue;
    const rel = path.relative(srcDir, uri.fsPath);
    if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const remoteName = rel.replace(/\\/g, "/");
    setStatus("uploading", `removing ${remoteName}...`);
    const result = await removeWithFallback(toolOpts, remoteName);
    if (result.success) {
      updateSyncTimestamp();
      outputChannel.appendLine(`Removed ${remoteName}`);
    } else {
      outputChannel.appendLine(`Failed to remove ${remoteName}: ${result.error}`);
    }
  }
}

async function doUploadFile(signal?: AbortSignal, uri?: vscode.Uri): Promise<void> {
  const cfg = getConfigOrNull();
  if (uri && cfg && !isUriUnderSrc(uri, cfg)) {
    vscode.window.showWarningMessage("Only files inside the configured src/ directory are synced to the device.");
    return;
  }
  await mirrorSrcToDevice({ changedOnly: false, signal });
}

async function doUploadChanges(signal?: AbortSignal): Promise<void> {
  await mirrorSrcToDevice({ changedOnly: true, signal });
}

async function doRunFile(signal?: AbortSignal, item?: { remoteFile?: FileEntry; module?: LuaModuleInfo }): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  let remoteName = item?.remoteFile?.name;
  if (!remoteName) {
    const fw = await getFirmwarePath();
    if (!fw) return;
    const modules = await listLuaModulesFromFirmware(fw);
    const pick = await vscode.window.showQuickPick(
      modules.map((m) => ({ label: m.name, description: m.description, module: m })),
      { placeHolder: "Select a Lua file to run" }
    );
    if (!pick) return;
    remoteName = pick.module.name + ".lua";
  }
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  setStatus("uploading", `running ${remoteName}...`);
  const opts = { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false, signal };
  const r = await runFileWithFallback(opts, remoteName);
  if (r.success) {
    setStatus("success", `ran ${remoteName}`);
    vscode.window.showInformationMessage(`Ran ${remoteName}`);
  } else {
    setStatus("error", "run FAILED");
    vscode.window.showErrorMessage(`Failed to run ${remoteName}: ${r.error}`);
  }
}

async function doResetDevice(signal?: AbortSignal): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  setStatus("uploading", `resetting device...`);
  const opts = { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false, signal };
  const r = await resetWithFallback(opts);
  if (!r.success) {
    setStatus("error", "reset FAILED");
    vscode.window.showErrorMessage(`Failed to reset device: ${r.error}`);
    return;
  }
  setStatus("success", `reset device`);
  vscode.window.showInformationMessage(`Reset device successfully.`);
}

async function doSyncLuaModules(signal?: AbortSignal): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = await getFirmwarePath();
  if (!cfg || !fw) return;
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const resolved = await resolveAllLuaModules(workspaceRoot, fw, cfg);
  const local = resolved.filter((m) => !m.isRemote && m.exists);
  if (local.length === 0) {
    vscode.window.showInformationMessage("No local Lua modules to sync.");
    return;
  }
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  const identity = await ensureKnownDevice(cfg, port, signal);
  if (!identity.allowed) return;
  for (const m of local) {
    setStatus("uploading", `uploading ${m.name}...`);
    const r = await uploadWithFallback(
      { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: true, signal },
      m.resolvedLocalPath!,
      m.name + ".lc",
    );
    if (!r.success) {
      vscode.window.showErrorMessage(`Failed to upload ${m.name}: ${r.error}`);
    }
  }
  setStatus("success", `synced ${local.length} module(s)`);
}

async function doAcceptLuaModuleCompletion(signal: AbortSignal | undefined, moduleName: string, source: string): Promise<void> {
  const cfg = getConfigOrNull();
  const iniPath = existingIniPath();
  if (!cfg || !iniPath) {
    vscode.window.showWarningMessage(`Inserted ${moduleName}, but no nodemcu.ini was found to enable it.`);
    return;
  }
  const newCfg = setLuaModule(cfg, moduleName, source);
  cachedConfig = newCfg;
  saveConfig(iniPath, newCfg);
  refreshAll();
  await doSyncLuaModules(signal);
}

async function doUploadAndMonitor(signal?: AbortSignal): Promise<void> {
  await closeSerialMonitors();
  await doUploadChanges(signal);
  if (statusEmitter.getState() === "error") return;
  await doSyncLuaModules(signal);
  if (statusEmitter.getState() === "error") return;
  await doOpenSerialMonitor(signal);
}

async function doRegenerateLuaApi(): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = await getFirmwarePath();
  if (!cfg || !fw) return;
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  outputChannel.show(true);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Regenerating Lua API files...`);
  const modules = Object.entries(cfg.c_modules).filter(([_, v]) => v).map(([k]) => k);
  const apiPath = path.join(workspaceRoot, ".vscode", "nodemcu-api.lua");
  generateLuaApiFile({ modules, outputPath: apiPath });
  const luaDirs = [luaModulesDir(fw), path.join(workspaceRoot, "lua")];
  writeLuaRc({ workspaceRoot, luaModulesDirs: luaDirs, apiFile: apiPath });
  vscode.window.showInformationMessage(`Generated ${apiPath}`);
}

async function doAddLuaModule(item?: { module: LuaModuleInfo }): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = await getFirmwarePath();
  if (!cfg) {
    vscode.window.showErrorMessage("No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first.");
    return;
  }
  if (!fw) return;
  outputChannel.show(true);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Adding Lua module...`);
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
  const iniPath = existingIniPath();
  if (iniPath) {
    cachedConfig = newCfg;
    saveConfig(iniPath, newCfg);
    refreshAll();
  }
}

async function doToggleLuaModule(item?: { module: LuaModuleInfo }): Promise<void> {
  if (!item?.module) {
    await doAddLuaModule();
    return;
  }
  outputChannel.show(true);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Toggling Lua module ${item.module.name}...`);
  const cfg = getConfigOrNull();
  if (!cfg) {
    vscode.window.showErrorMessage("No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first.");
    return;
  }
  const nextCfg = { ...cfg, lua_modules: { ...cfg.lua_modules } };
  if (nextCfg.lua_modules[item.module.name]) {
    delete nextCfg.lua_modules[item.module.name];
  } else {
    nextCfg.lua_modules[item.module.name] = `lua_modules/${item.module.name}/${path.basename(item.module.mainFile)}`;
  }
  const iniPath = existingIniPath();
  if (iniPath) {
    cachedConfig = nextCfg;
    saveConfig(iniPath, nextCfg);
    refreshAll();
  }
}

async function doToggleCModule(item?: { module: CModuleInfo }): Promise<void> {
  outputChannel.show(true);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Toggling C module...`);
  const cfg = getConfigOrNull();
  if (!cfg) {
    vscode.window.showErrorMessage("No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first.");
    return;
  }
  const fw = await getFirmwarePath();
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
  const iniPath = existingIniPath();
  if (iniPath) {
    cachedConfig = newCfg;
    saveConfig(iniPath, newCfg);
    writeUserModulesHeader(userModulesHeader(fw), newCfg);
    refreshAll();
  }
}

function doRefreshExplorer(): void {
  outputChannel.show(true);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Refreshing explorer...`);
  refreshAll();
  void refreshDetectedPortsAndMaybeSelect();
}

function doOpenIni(): void {
  const iniPath = getIniPath();
  if (!iniPath) return;
  outputChannel.show(true);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Opening nodemcu.ini...`);
  vscode.window.showTextDocument(vscode.Uri.file(iniPath));
}

export async function closeSerialMonitors(): Promise<ClosedSerialMonitor[]> {
  const monitors = vscode.window.terminals.filter(t => t.name.startsWith("NodeMCU: "));
  const closed = monitors.map((terminal) => ({
    name: terminal.name,
    port: terminal.name.slice("NodeMCU: ".length).trim(),
  })).filter((monitor) => monitor.port.length > 0);
  const pids = await Promise.all(monitors.map(async (t) => {
    try {
      return await t.processId;
    } catch {
      return undefined;
    }
  }));
  for (const t of monitors) {
    try {
      t.sendText("\x03", false);
    } catch {
      // Ignore terminals that are already shutting down.
    }
    t.dispose();
  }
  if (process.platform === "win32") {
    for (const pid of pids) {
      if (!pid) continue;
      try {
        child_process.spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true });
      } catch {
        // Best-effort cleanup; the terminal may already be gone.
      }
    }
  }
  if (monitors.length > 0 && process.platform === "win32") {
    await new Promise(r => setTimeout(r, 2500)); // Increased from 1000 to 2500
  }
  return closed;
}

function openSerialMonitorTerminal(port: string, baud: number): void {
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const term = vscode.window.createTerminal({
    name: `NodeMCU: ${port}`,
    shellPath: python,
    shellArgs: ["-m", "serial.tools.miniterm", port, String(baud)],
  });
  term.show();
}

export async function restoreSerialMonitors(monitors: ClosedSerialMonitor[], cfg: NodemcuConfig, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || monitors.length === 0) return;
  const uniquePorts = Array.from(new Set(monitors.map((monitor) => monitor.port)));
  for (const port of uniquePorts) {
    openSerialMonitorTerminal(port, cfg.nodemcu.baud);
  }
}

async function doOpenSerialMonitor(_signal?: AbortSignal): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  openSerialMonitorTerminal(port, cfg.nodemcu.baud);
}

function buildDeviceExplorerProvider(): AsyncTreeProvider {
  return new AsyncTreeProvider(async () => {
    const cfg = getConfigOrNull();
    const ports = await new SerialDiscovery(new Shell()).list();
    const settingPort = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("port") || "";
    const selection = chooseAutoPort(ports, cfg, settingPort);
    const selectedPort = selection?.port || availableConfiguredPort(ports, cfg, settingPort);
    return ports.length === 0
      ? [{
          id: "device-no-ports",
          label: "No serial ports detected",
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          iconPath: new vscode.ThemeIcon("warning"),
        }]
      : ports.map((p) => ({
          id: `device-port-${p.path}`,
          label: p.path,
          description: [p.manufacturer, p.path === selectedPort ? "selected" : ""].filter(Boolean).join(" "),
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          contextValue: "nodemcu.serialPort",
          iconPath: new vscode.ThemeIcon(p.path === selectedPort ? "plug-filled" : "plug"),
          serialPort: p,
          command: { command: "nodemcu-vscode.selectPort", title: "Select Port", arguments: [{ serialPort: p }] },
        }));
  });
}

function buildLuaModulesProvider(): AsyncTreeProvider {
  return new AsyncTreeProvider(async () => {
    const cfg = getConfigOrNull();
    if (!cfg) {
      return [{
        id: "lua-no-config",
        label: "No nodemcu.ini found",
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: new vscode.ThemeIcon("warning"),
      }];
    }
    const fw = await getFirmwarePath();
    if (!fw) {
      return [{
        id: "lua-no-firmware",
        label: "Managed firmware unavailable",
        description: "Check download status or settings",
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: new vscode.ThemeIcon("warning"),
      }];
    }
    const mods = await listLuaModulesFromFirmware(fw);
    if (mods.length === 0) {
      return [{
        id: "lua-empty",
        label: "No Lua modules found",
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: new vscode.ThemeIcon("info"),
      }];
    }
    return mods.map((m) => ({
      id: `lua-module-${m.name}`,
      label: m.name,
      description: m.description,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: "nodemcu.luaModule",
      iconPath: new vscode.ThemeIcon("library"),
      checkboxState: cfg?.lua_modules[m.name] ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      luaModule: m,
      command: {
        command: "nodemcu-vscode.toggleLuaModule",
        title: "Toggle Lua Module",
        arguments: [{ module: m }],
      },
    }));
  });
}

function buildCModulesProvider(): AsyncTreeProvider {
  return new AsyncTreeProvider(async () => {
    const cfg = getConfigOrNull();
    if (!cfg) {
      return [{
        id: "c-no-config",
        label: "No nodemcu.ini found",
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: new vscode.ThemeIcon("warning"),
      }];
    }
    const fw = await getFirmwarePath();
    if (!fw) {
      return [{
        id: "c-no-firmware",
        label: "Managed firmware unavailable",
        description: "Check download status or settings",
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: new vscode.ThemeIcon("warning"),
      }];
    }
    const mods = await listCModules(fw);
    if (mods.length === 0) {
      return [{
        id: "c-empty",
        label: "No C modules found",
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: new vscode.ThemeIcon("info"),
      }];
    }
    return mods.map((m) => {
      const enabled = cfg?.c_modules[m.name] ?? false;
      return {
        id: `c-module-${m.name}`,
        label: m.name,
        description: `${m.category}${enabled ? "  ✓ enabled" : ""}`,
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        contextValue: "nodemcu.cModule",
        checkboxState: enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
        cModule: m,
        iconPath: new vscode.ThemeIcon(enabled ? "check" : "circle-outline"),
        command: { command: "nodemcu-vscode.toggleCModule", title: "Toggle C Module", arguments: [{ module: m }] },
      };
    });
  });
}

function buildProjectTasksProvider(): AsyncTreeProvider {
  return new AsyncTreeProvider(async () => [
    {
      id: "task-init",
      label: "Initialize Project",
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon("new-folder"),
      command: { command: "nodemcu-vscode.initProject", title: "Initialize" },
    },
  ]);
}

class LuaModuleCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(): Promise<vscode.CompletionItem[]> {
    const fw = await getFirmwarePath();
    if (!fw) return [];
    const modules = await listLuaModulesFromFirmware(fw);
    return modules.map(createLuaModuleCompletionItem);
  }
}

function scheduleSrcSync(document: vscode.TextDocument): void {
  const cfg = getConfigOrNull();
  if (!cfg || !isUriUnderSrc(document.uri, cfg)) return;
  lastSavedUri = document.uri;
  if (srcSaveTimer) clearTimeout(srcSaveTimer);
  srcSaveTimer = setTimeout(() => {
    srcSaveTimer = undefined;
    const uri = lastSavedUri;
    lastSavedUri = undefined;
    if (!uri) return;
    const currentCfg = getConfigOrNull();
    if (!currentCfg) return;
    outputChannel.show(true);
    if (currentCfg.sync.last_timestamp) {
      outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] File saved, uploading single file...`);
      void operationGate.run("Upload file", (signal) => doUploadSingleFile(uri, currentCfg, signal));
    } else {
      outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] File saved, performing full sync...`);
      void operationGate.run("Sync src/", (signal) => mirrorSrcToDevice({ changedOnly: false, signal }));
    }
  }, 300);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("NodeMCU");
  operationGate = new OperationGate({
    onInterrupt: async (previousName: string) => {
      outputChannel.appendLine(`\n[${new Date().toLocaleTimeString()}] Interrupting: ${previousName}`);
      setStatus("uploading", `Interrupting ${previousName}...`);
      await closeSerialMonitors();
    },
  });
  statusEmitter = new StatusEmitter();
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "nodemcu-vscode.openIni";
  
  portStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  portStatusBarItem.command = "nodemcu-vscode.selectPort";
  
  context.subscriptions.push(statusBarItem, portStatusBarItem, outputChannel);
  setStatus("idle", "NodeMCU: idle");

  deviceExplorerProvider = buildDeviceExplorerProvider();
  luaModulesProvider = buildLuaModulesProvider();
  cModulesProvider = buildCModulesProvider();
  projectTasksProvider = buildProjectTasksProvider();
  
  vscode.window.registerTreeDataProvider("nodemcu.deviceExplorer", deviceExplorerProvider);
  vscode.window.registerTreeDataProvider("nodemcu.projectTasks", projectTasksProvider);

  const luaTreeView = vscode.window.createTreeView<TreeItemNode>("nodemcu.luaModules", {
    treeDataProvider: luaModulesProvider,
    manageCheckboxStateManually: true,
  });
  const cTreeView = vscode.window.createTreeView<TreeItemNode>("nodemcu.cModules", {
    treeDataProvider: cModulesProvider,
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(
    luaTreeView,
    cTreeView,
    vscode.workspace.onDidSaveTextDocument(scheduleSrcSync),
    vscode.workspace.onDidDeleteFiles(handleFileDelete),
  );

  cTreeView.onDidChangeCheckboxState(async (e) => {
    for (const [item] of e.items) {
      if (item.contextValue === "nodemcu.cModule" && item.cModule) {
        await doToggleCModule({ module: item.cModule });
      }
    }
  });

  luaTreeView.onDidChangeCheckboxState(async (e) => {
    for (const [item, state] of e.items) {
      if (item.contextValue === "nodemcu.luaModule" && item.luaModule) {
        if (state === vscode.TreeItemCheckboxState.Checked) {
          await doAddLuaModule({ module: item.luaModule });
        } else {
          // Remove it
          const cfg = getConfigOrNull();
          if (cfg) {
            const nextCfg = { ...cfg, lua_modules: { ...cfg.lua_modules } };
            delete nextCfg.lua_modules[item.luaModule.name];
            const iniPath = existingIniPath();
            if (iniPath) {
              cachedConfig = nextCfg;
              saveConfig(iniPath, nextCfg);
              refreshAll();
            }
          }
        }
      }
    }
  });

  const iniPath = getIniPath();
  if (iniPath && fs.existsSync(iniPath)) {
    watcher = new ConfigWatcher(iniPath);
    watcher.onChange((c) => {
      if (cachedConfig && cachedConfig.nodemcu.firmware_path !== c.nodemcu.firmware_path) {
        cachedFirmwarePath = null;
      }
      cachedConfig = c;
      refreshAll();
      updatePortStatusBar(c);
    });
    cachedConfig = watcher.current();
    watcher.start();
  }

  refreshAll();
  void projectTasksProvider.reload();
  
  void refreshDetectedPortsAndMaybeSelect();
  portRefreshTimer = setInterval(() => {
    void refreshDetectedPortsAndMaybeSelect();
  }, 5000);
  context.subscriptions.push(new vscode.Disposable(() => {
    if (portRefreshTimer) clearInterval(portRefreshTimer);
    if (srcSaveTimer) clearTimeout(srcSaveTimer);
    lastSavedUri = undefined;
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand("nodemcu-vscode.initProject", doInitProject),
    vscode.commands.registerCommand("nodemcu-vscode.build", commandWithOperation("Build Firmware", doBuild)),
    vscode.commands.registerCommand("nodemcu-vscode.flash", commandWithOperation("Flash Firmware", doFlash)),
    vscode.commands.registerCommand("nodemcu-vscode.buildAndFlash", commandWithOperation("Build & Flash", doBuildAndFlash)),
    vscode.commands.registerCommand("nodemcu-vscode.uploadFile", commandWithOperation("Upload File", doUploadFile)),
    vscode.commands.registerCommand("nodemcu-vscode.uploadChanges", commandWithOperation("Upload Changes", doUploadChanges)),
    vscode.commands.registerCommand("nodemcu-vscode.uploadAndMonitor", commandWithOperation("Upload & Monitor", doUploadAndMonitor)),
    vscode.commands.registerCommand("nodemcu-vscode.runFile", commandWithOperation("Run File", doRunFile)),
    vscode.commands.registerCommand("nodemcu-vscode.resetDevice", commandWithOperation("Reset Device", doResetDevice)),
    vscode.commands.registerCommand("nodemcu-vscode.syncLuaModules", commandWithOperation("Sync Lua Modules", doSyncLuaModules)),
    vscode.commands.registerCommand("nodemcu-vscode.acceptLuaModuleCompletion", commandWithOperation("Accept Lua Module", doAcceptLuaModuleCompletion)),
    vscode.commands.registerCommand("nodemcu-vscode.openSerialMonitor", commandWithOperation("Open Serial Monitor", doOpenSerialMonitor)),
    vscode.commands.registerCommand("nodemcu-vscode.regenerateLuaApi", doRegenerateLuaApi),
    vscode.commands.registerCommand("nodemcu-vscode.addLuaModule", doAddLuaModule),
    vscode.commands.registerCommand("nodemcu-vscode.toggleLuaModule", doToggleLuaModule),
    vscode.commands.registerCommand("nodemcu-vscode.toggleCModule", doToggleCModule),
    vscode.commands.registerCommand("nodemcu-vscode.refreshExplorer", doRefreshExplorer),
    vscode.commands.registerCommand("nodemcu-vscode.openIni", doOpenIni),
    vscode.commands.registerCommand("nodemcu-vscode.selectPort", doSelectPort),
    vscode.languages.registerCompletionItemProvider(
      { language: "ini", pattern: "**/nodemcu.ini" },
      new IniCompletionItemProvider(),
      "[", "="
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: "lua" },
      new LuaModuleCompletionProvider(),
      ..."_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")
    )
  );

}

export function deactivate(): void {
  if (portRefreshTimer) clearInterval(portRefreshTimer);
  watcher?.stop();
}
