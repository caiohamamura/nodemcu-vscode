import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { Shell } from "./util/shell";
import { CommandQueue } from "./util/commandQueue";
import {
  defaultConfig,
  loadConfig,
  parseIni,
  saveConfig,
  addDeviceUuid,
  hasDeviceUuid,
  setCModule,
  setLuaModule,
  setGraphicsEntry,
  isLfsEnabled,
  TLS_ENABLE_SSL_BUFFER_SIZE,
  DEFAULT_LFS_SIZE,
  type GraphicsSection,
  type NodemcuConfig,
} from "./config/nodemcuIni";
import { IniCompletionItemProvider } from "./config/iniCompletion";
import { ConfigWatcher } from "./config/configWatcher";
import { resolveFirmwarePath, luaModulesDir, userModulesHeader, u8g2FontsHeader, ucgConfigHeader, luacCrossPath, lfsImagePath } from "./util/paths";
import { readActiveEntries } from "./build/graphicsConfigWriter";
import { listU8g2Fonts, listUcgFonts } from "./firmware/graphicsCatalog";
import { createFontCompletionItem, type FontLib } from "./luaPicker/fontCompletion";
import { LuaDiagnosticsController } from "./lua/luaDiagnosticsController";
import { NodemcuLuaCodeActionProvider } from "./lua/luaCodeActions";
import { isCModulesConfigChanged } from "./build/userModulesWriter";
import { BuildManager } from "./build/buildManager";
import { ToolchainLocator } from "./build/toolchain";
import { buildLfsImage } from "./build/lfsBuilder";
import { FlashManager } from "./flash/flashManager";
import { chooseAutoPort } from "./flash/autoPort";
import { SerialDiscovery, serialPortDisplayName, type SerialPort } from "./flash/serialDiscovery";
import { NodemcuTool, type FileEntry, type NodemcuToolOptions } from "./upload/nodemcuTool";
import { readDeviceIdentity, type DeviceIdentity } from "./device/deviceIdentity";
import { readDeviceFirmwareInfo } from "./device/deviceFirmwareInfo";
import { SerialDeviceClient } from "./device/serialDeviceClient";
import { planMirrorSync } from "./upload/srcMirror";
import { StatusEmitter, type BuildState, type StatusUpdate } from "./status/statusBar";
import { PythonManager } from "./python/pythonManager";
import { listLuaModulesFromFirmware, listCModules, selectMainFileForConfig, type LuaModuleInfo, type CModuleInfo } from "./luaPicker/moduleList";
import { createLuaModuleCompletionItem, luaModuleSource } from "./luaPicker/luaModuleCompletion";
import { resolveAllLuaModules } from "./luaPicker/luaModuleResolver";
import { writeLuaRc } from "./luaApi/apiFiles";
import { ensureManagedFirmware } from "./firmware/managedFirmware";
import { resolvePrebuiltLuacCross, installPrebuiltLuacCross, luacFlavour, readInstalledLuacFlavour, installedLuacMatchesFlavour, currentPrebuiltTarget } from "./firmware/prebuiltLuacCross";
import { ensureCMake, ensureNinja } from "./tools/managedTools";
import { SerialSessionManager } from "./serial/serialSessionManager";
import { SerialConsoleViewProvider } from "./serial/serialConsoleView";
import { ManagedLuaServer } from "./lua/managedLuaServer";
import { mapFirmwareAPI, generateEmmyLuaStub, generateMarkdownReport } from "./firmware/firmwareMapper";

let outputChannel: vscode.OutputChannel;
let managedLuaServer: ManagedLuaServer | undefined;
let statusEmitter: StatusEmitter;
let portStatusBarItem: vscode.StatusBarItem;
let queueStatusBarItem: vscode.StatusBarItem;
let watcher: ConfigWatcher | undefined;
let cachedConfig: NodemcuConfig | null = null;
let cachedFirmwarePath: string | null = null;
let pendingFirmwarePromise: Promise<string | null> | null = null;
let extensionContext: vscode.ExtensionContext;
let serialSessionManager: SerialSessionManager;
let serialConsoleViewProvider: SerialConsoleViewProvider;
let serialAutoConnectSuppressed = false;
let luaDiagnostics: LuaDiagnosticsController | undefined;

const SERIAL_AUTO_CONNECT_SUPPRESSED_KEY = "nodemcu.serialAutoConnectSuppressed";

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
let commandQueue: CommandQueue;
let projectTasksProvider: AsyncTreeProvider;
let srcSaveTimer: NodeJS.Timeout | undefined;
let lastSavedUri: vscode.Uri | undefined;
let pythonManager: PythonManager | undefined;
let managedCMakePath: string | undefined;
let managedNinjaPath: string | undefined;

const LEGACY_DEFAULT_FIRMWARE_PATH = "../nodemcu-firmware";

function getPythonPath(): string {
  if (pythonManager?.python) return pythonManager.python;
  return vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") || "python";
}

/**
 * Like getPythonPath, but waits for the managed venv to finish setting up
 * first. The venv is created asynchronously on activation (download managed
 * Python, create venv, pip install esptool/pyserial — minutes on a clean
 * machine). A build triggered before it finishes would see `pythonManager.python`
 * still empty and fall back to the literal "python", which CMake cannot resolve
 * as `Python3_EXECUTABLE` and reports as "Could NOT find Python3". Waiting here
 * means the first build gets a real interpreter path instead of failing until a
 * later retry happens to land after setup completed.
 */
async function getReadyPythonPath(): Promise<string> {
  if (!pythonManager && extensionContext) {
    await ensurePython(extensionContext);
  } else if (pythonManager) {
    try {
      await pythonManager.pythonPromise;
    } catch {
      // Setup failed and cleared the manager; getPythonPath falls back to the
      // configured/system interpreter below.
    }
  }
  return getPythonPath();
}

function getConfiguredBaud(cfg: NodemcuConfig | null | undefined): number {
  return cfg?.nodemcu.baud && cfg.nodemcu.baud > 0 ? cfg.nodemcu.baud : 115200;
}

function allowNodemcuToolFallback(): boolean {
  return vscode.workspace.getConfiguration("nodemcu-vscode").get<boolean>("experimental.allowNodemcuToolFallback") ?? false;
}

async function ensureSerialSession(cfg: NodemcuConfig): Promise<{ port: string; client: SerialDeviceClient } | null> {
  const port = await ensurePort(cfg);
  if (!port) {
    return null;
  }
  const session = await serialSessionManager.switchPort(port, getConfiguredBaud(cfg));
  return { port, client: new SerialDeviceClient(session) };
}

async function setSerialAutoConnectSuppressed(value: boolean): Promise<void> {
  serialAutoConnectSuppressed = value;
  await extensionContext?.workspaceState.update(SERIAL_AUTO_CONNECT_SUPPRESSED_KEY, value);
}

async function focusAndConnectSerialConsole(options: { force?: boolean } = {}): Promise<{ port: string; client: SerialDeviceClient } | null> {
  if (serialAutoConnectSuppressed && !options.force) {
    return null;
  }
  if (options.force) {
    await setSerialAutoConnectSuppressed(false);
  }
  await serialConsoleViewProvider.reveal();
  const cfg = getConfigOrNull();
  if (!cfg) {
    return null;
  }
  return await ensureSerialSession(cfg);
}

async function ensurePython(context: vscode.ExtensionContext): Promise<void> {
  if (pythonManager) return;
  const configuredPython = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath");
  pythonManager = new PythonManager({
    storagePath: context.globalStorageUri.fsPath,
    systemPython: configuredPython === "python" ? undefined : (configuredPython ?? undefined),
    onProgress: (msg) => outputChannel?.appendLine(`[python] ${msg}`),
  });
  try {
    await pythonManager.pythonPromise;
    outputChannel?.appendLine(`[python] Using managed Python at ${pythonManager.python}`);
  } catch (err) {
    outputChannel?.appendLine(`[python] Managed Python setup failed: ${err}`);
    outputChannel?.appendLine("[python] Falling back to system Python from PATH or setting.");
    pythonManager = undefined;
  }
}

async function resolveManagedTools(): Promise<{ cmake?: string; ninja?: string }> {
  const storageRoot = extensionContext.globalStorageUri.fsPath;
  const progress = (msg: string) => outputChannel?.appendLine(`[tools] ${msg}`);

  if (!managedCMakePath) {
    try {
      managedCMakePath = await ensureCMake({ storageRoot, onProgress: progress });
      outputChannel?.appendLine(`[tools] Using managed CMake at ${managedCMakePath}`);
    } catch (err) {
      outputChannel?.appendLine(`[tools] Managed CMake unavailable: ${err}`);
      outputChannel?.appendLine("[tools] Falling back to system CMake from PATH.");
    }
  }

  if (!managedNinjaPath) {
    try {
      managedNinjaPath = await ensureNinja({ storageRoot, onProgress: progress });
      outputChannel?.appendLine(`[tools] Using managed Ninja at ${managedNinjaPath}`);
    } catch (err) {
      outputChannel?.appendLine(`[tools] Managed Ninja unavailable: ${err}`);
      outputChannel?.appendLine("[tools] Falling back to system Ninja from PATH.");
    }
  }

  return { cmake: managedCMakePath, ninja: managedNinjaPath };
}

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
  const configured = normalizeConfiguredFirmwarePath(configuredSetting || configuredIni);
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
          storageRoot: process.env.NODEMCU_VSCODE_STORAGE_ROOT || extensionContext.globalStorageUri.fsPath,
          onProgress: (message) => progress.report({ message }),
        }),
      );
      cachedFirmwarePath = fwPath;
      refreshAll();
      luaDiagnostics?.invalidateCatalog();
      luaDiagnostics?.refreshAll();
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

function normalizeConfiguredFirmwarePath(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed === LEGACY_DEFAULT_FIRMWARE_PATH ? "" : trimmed;
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

// Operation progress is surfaced as a notification (toast) rather than a cryptic
// status-bar item. The status bar is reserved for persistent info (the port).
// `statusEmitter` is still the single source of truth for state (read by tests).
let progressActive = false;
let progressReport: ((value: { message?: string }) => void) | null = null;
let progressDone: (() => void) | null = null;

function isWorkingState(state: BuildState): boolean {
  return state === "configuring" || state === "building" || state === "flashing" || state === "uploading";
}

function statusMessage(update: StatusUpdate): string {
  return update.detail ? `${update.text} — ${update.detail}` : update.text;
}

function presentStatus(update: StatusUpdate): void {
  if (isWorkingState(update.state)) {
    if (!progressActive) {
      // Open a single long-lived progress toast for the operation; later working
      // updates just retitle its message via progress.report().
      progressActive = true;
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "NodeMCU", cancellable: false },
        (progress) => {
          progressReport = (value) => progress.report(value);
          progress.report({ message: statusMessage(update) });
          return new Promise<void>((resolve) => {
            progressDone = resolve;
          });
        },
      );
    } else {
      progressReport?.({ message: statusMessage(update) });
    }
    return;
  }
  // Terminal / idle: close any open progress toast, then surface the result.
  if (progressActive) {
    progressDone?.();
    progressActive = false;
    progressReport = null;
    progressDone = null;
  }
  if (update.state === "success") {
    void vscode.window.showInformationMessage(`NodeMCU: ${update.text}`);
  } else if (update.state === "error") {
    void vscode.window.showErrorMessage(`NodeMCU: ${update.text}`);
  }
}

function setStatus(state: BuildState, text: string, detail?: string): void {
  const update: StatusUpdate = { state, text, detail };
  statusEmitter.update(update);
  if (state !== "idle") {
    outputChannel?.appendLine(`[${new Date().toLocaleTimeString()}] ${text}${detail ? ` - ${detail}` : ""}`);
  }
  presentStatus(update);
}

function showOperationLog(name: string): void {
  outputChannel.appendLine(`\n[${new Date().toISOString()}] Starting ${name}`);
}

function updateQueueStatusBar(): void {
  if (!queueStatusBarItem) return;
  const state = commandQueue.getState();
  if (state.running) {
    const pendingCount = state.pending.length;
    queueStatusBarItem.text = pendingCount > 0
      ? `$(sync~spin) ${state.running.name} | ${pendingCount} queued`
      : `$(sync~spin) ${state.running.name}`;
    queueStatusBarItem.tooltip = pendingCount > 0
      ? `Running: ${state.running.name}\nQueued: ${state.pending.map((p) => p.name).join(", ")}`
      : `Running: ${state.running.name}`;
    queueStatusBarItem.show();
  } else {
    queueStatusBarItem.hide();
  }
}

function commandWithOperation<T extends unknown[]>(
  name: string,
  fn: (signal: AbortSignal, ...args: T) => Promise<void> | void,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    showOperationLog(name);
    const state = commandQueue.getState();
    const wasQueued = state.running !== null;
    if (wasQueued) {
      const position = state.pending.length + 1;
      outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${name} queued (position ${position})`);
      void vscode.window.showInformationMessage(
        `NodeMCU: ${name} queued (${position} in queue). Running: ${state.running!.name}`,
        "Cancel Queued",
      ).then((choice) => {
        if (choice === "Cancel Queued") {
          commandQueue.cancelPending();
          outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Queued commands cancelled by user`);
        }
      });
    }
    await commandQueue.enqueue(name, async (signal) => {
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
    const name = port ? serialPortDisplayName(port) : "";
    const suffix = name ? ` (${name})` : "";
    const session = serialSessionManager?.getCurrentSession();
    if (session && session.port === selectedPort) {
      const state = session.getState();
      if (state === "busy" || state === "booting" || state === "opening") {
        portStatusBarItem.text = `$(sync~spin) ${selectedPort}${suffix}`;
      } else if (state === "released-for-flash") {
        portStatusBarItem.text = `$(debug-disconnect) ${selectedPort}${suffix}`;
      } else {
        portStatusBarItem.text = `$(plug) ${selectedPort}${suffix}`;
      }
      portStatusBarItem.tooltip = `Serial session ${state}. Click to select a serial port`;
      portStatusBarItem.show();
      return;
    }
    portStatusBarItem.text = `$(plug) ${selectedPort}${suffix}`;
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
      // Write through the live config, not the caller's snapshot, so a
      // concurrent edit (e.g. a module toggle) isn't clobbered.
      const current = getConfigOrNull() ?? cfg;
      current.nodemcu.port = selection.port;
      cachedConfig = current;
      const iniPath = existingIniPath();
      if (iniPath) saveConfig(iniPath, current);
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
    void serialSessionManager.closeAll();
    updatePortStatusBar(cfg);
    refreshAll();
    if (!serialAutoConnectSuppressed) {
      void focusAndConnectSerialConsole();
    }
  }
}

async function doSelectPort(item?: { serialPort?: SerialPort } | SerialPort): Promise<string | null> {
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
    description: serialPortDisplayName(p),
  }));
  
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Select serial port" });
  if (!pick) return null;
  
  saveSelectedPort(pick.label);
  return pick.label;
}

async function doBuild(signal?: AbortSignal): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = await getFirmwarePath();
  if (!cfg) {
    vscode.window.showErrorMessage("No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first.");
    return;
  }
  if (!fw) {
    vscode.window.showErrorMessage("NodeMCU firmware is unavailable. Check the managed firmware download or any custom firmware_path override.");
    return;
  }
  setStatus("configuring", "configuring...");
  const tools = await resolveManagedTools();
  const toolchain = await new ToolchainLocator(new Shell(), await getReadyPythonPath(), tools.cmake, tools.ninja).locate();
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
    preferredCmake: tools.cmake,
    preferredNinja: tools.ninja,
    python: toolchain.python,
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
  await flashFirmware(signal, { postFlashSync: true });
}

/**
 * Flash the built firmware. `postFlashSync: true` (the standalone Flash /
 * Build & Flash commands) follows a first-time device claim with a full
 * mirror. When the flash is triggered from inside mirrorSrcToDevice
 * (postFlashSync: false), that nested mirror must be skipped — the outer
 * mirror formats and syncs once itself; running both formats the device twice
 * and emits a misleading early "synced" toast while the outer pass is still
 * running.
 */
async function flashFirmware(signal: AbortSignal | undefined, opts: { postFlashSync: boolean }): Promise<void> {
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
  const identity = await ensureKnownDevice(cfg, port, signal);
  if (!identity.allowed) return;
  setStatus("flashing", `flashing ${port}...`);
  const python = getPythonPath();
  const mgr = new FlashManager(new Shell());
  const r = await serialSessionManager.withPortReleased(port, async () => await mgr.flash({
    python,
    firmwarePath: fw,
    config: cfg,
    port,
    onLog: (s) => outputChannel.append(s),
    onStderr: (s) => outputChannel.append(s),
    signal,
  }));
  if (r.success) {
    setStatus("success", `flashed ${port}`);
    vscode.window.showInformationMessage(`Flashed ${port} in ${r.durationMs}ms`);
    const serial = serialAutoConnectSuppressed ? null : await focusAndConnectSerialConsole();
    if (serial) {
      await serial.client.reset().catch(() => {});
    }
    if (opts.postFlashSync && identity.isNew) {
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

/** Build + flash for use inside a mirror: the outer mirror owns format/sync. */
async function buildAndFlashForSync(signal?: AbortSignal): Promise<void> {
  await doBuild(signal);
  if (statusEmitter.getState() === "success" && !signal?.aborted) {
    await flashFirmware(signal, { postFlashSync: false });
  }
}

async function doInitProject(): Promise<void> {
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
    const previous = cachedConfig;
    const serialConfigChanged = !!previous
      && (previous.nodemcu.port !== c.nodemcu.port || getConfiguredBaud(previous) !== getConfiguredBaud(c));
    if (serialConfigChanged) {
      void serialSessionManager.closeAll();
    }
    cachedConfig = c;
    cachedFirmwarePath = null;
    refreshAll();
    updatePortStatusBar(c);
    if (serialConfigChanged && !serialAutoConnectSuppressed) {
      void focusAndConnectSerialConsole();
    }
  });
  cachedConfig = loadConfig(iniPath);
  watcher.start();
  await setSerialAutoConnectSuppressed(false);
  refreshAll();
  updatePortStatusBar(cachedConfig);
  void focusAndConnectSerialConsole();
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
  const session = await serialSessionManager.switchPort(opts.port, opts.baud);
  const client = new SerialDeviceClient(session);
  const directResult = await client.upload(localPath, remoteName, { compile: opts.compile, signal: opts.signal });
  if (directResult.success || !allowNodemcuToolFallback() || !shouldUseNodemcuToolFallback(directResult.error)) return directResult;

  outputChannel.appendLine(`\nShared serial upload failed (${directResult.error}). Retrying with nodemcu-tool...`);
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
  const session = await serialSessionManager.switchPort(opts.port, opts.baud);
  const client = new SerialDeviceClient(session);
  const directResult = await client.listFiles();
  if (directResult.success || !allowNodemcuToolFallback() || !shouldUseNodemcuToolFallback(directResult.error)) return directResult;

  outputChannel.appendLine(`\nShared serial file listing failed (${directResult.error}). Retrying with nodemcu-tool...`);
  const tool = await nodemcuToolFallback(opts.python, promptInstall);
  if (!tool) return directResult;
  return await tool.listFilesResult(opts, (s) => outputChannel.append(s));
}

async function removeWithFallback(opts: NodemcuToolOptions, remoteName: string): Promise<{ success: boolean; error?: string }> {
  const session = await serialSessionManager.switchPort(opts.port, opts.baud);
  const client = new SerialDeviceClient(session);
  const directResult = await client.remove(remoteName);
  if (directResult.success || !allowNodemcuToolFallback() || !shouldUseNodemcuToolFallback(directResult.error)) return directResult;

  outputChannel.appendLine(`\nShared serial delete failed (${directResult.error}). Retrying with nodemcu-tool...`);
  const tool = await nodemcuToolFallback(opts.python);
  if (!tool) return directResult;
  return await tool.remove(opts, remoteName, (s) => outputChannel.append(s));
}

async function runFileWithFallback(opts: NodemcuToolOptions, remoteName: string): Promise<{ success: boolean; error?: string }> {
  const session = await serialSessionManager.switchPort(opts.port, opts.baud);
  const client = new SerialDeviceClient(session);
  const directResult = await client.runFile(remoteName);
  if (directResult.success || !allowNodemcuToolFallback() || !shouldUseNodemcuToolFallback(directResult.error)) return directResult;

  outputChannel.appendLine(`\nShared serial run failed (${directResult.error}). Retrying with nodemcu-tool...`);
  const tool = await nodemcuToolFallback(opts.python);
  if (!tool) return directResult;
  return await tool.runFile(opts, remoteName, (s) => outputChannel.append(s));
}

async function resetWithFallback(opts: NodemcuToolOptions): Promise<{ success: boolean; error?: string }> {
  const session = await serialSessionManager.switchPort(opts.port, opts.baud);
  const client = new SerialDeviceClient(session);
  const directReset = await client.reset();
  if (directReset.success) return { success: true };
  outputChannel.appendLine(`Shared serial reset failed (${directReset.error}). Retrying with nodemcu-tool reset...`);
  if (!allowNodemcuToolFallback() || !shouldUseNodemcuToolFallback(directReset.error)) return directReset;
  const tool = await nodemcuToolFallback(opts.python);
  if (!tool) return directReset;
  const r = await tool.reset(opts, (s) => outputChannel.append(s));
  if (r.success) return { success: true };
  outputChannel.appendLine(`Reset via nodemcu-tool failed: ${r.error}`);
  return r;
}

async function formatWithFallback(opts: NodemcuToolOptions): Promise<{ success: boolean; error?: string }> {
  const session = await serialSessionManager.switchPort(opts.port, opts.baud);
  const client = new SerialDeviceClient(session);
  const directResult = await client.mkfs();
  if (directResult.success || !allowNodemcuToolFallback()) {
    return directResult;
  }
  const tool = await nodemcuToolFallback(opts.python);
  if (!tool) return directResult;
  return await tool.mkfs(opts, (s) => outputChannel.append(s));
}

async function ensureKnownDevice(cfg: NodemcuConfig, port: string, signal?: AbortSignal): Promise<{ allowed: boolean; identity?: DeviceIdentity; isNew: boolean }> {
  const python = getPythonPath();
  const result = await serialSessionManager.withPortReleased(
    port,
    async () => await readDeviceIdentity({ shell: new Shell(), python, port, baud: getConfiguredBaud(cfg), signal }),
  );
  if (!result.success || !result.identity) {
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] readDeviceIdentity failed: ${result.error}`);
    vscode.window.showErrorMessage(`Unable to identify attached NodeMCU device: ${result.error}`);
    return { allowed: false, isNew: false };
  }
  if (hasDeviceUuid(cfg, result.identity.uuid)) {
    return { allowed: true, identity: result.identity, isNew: false };
  }

  // Fresh workspace (no devices registered yet): auto-add silently — the user is working from scratch.
  if (cfg.devices.uuids.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Device ${result.identity.macAddress} is not listed in nodemcu.ini for this workspace. Proceeding will add it, format the device filesystem, and sync files from src/.`,
      "Proceed",
      "Cancel",
    );
    if (choice !== "Proceed") {
      vscode.window.showWarningMessage("Open the workspace that matches this device, or proceed after confirming this workspace should own it.");
      return { allowed: false, identity: result.identity, isNew: true };
    }
  }

  const iniPath = existingIniPath();
  if (iniPath) {
    // Re-read the live config at write time: the identity read takes seconds,
    // and saving the caller's snapshot would clobber any module toggles or
    // other edits made meanwhile (same class of bug as the sync-timestamp
    // clobber fixed on 2026-06-08).
    const current = getConfigOrNull() ?? cfg;
    const next = addDeviceUuid(current, result.identity.uuid);
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

// Content-hash tracking so we only upload a file when its bytes actually
// changed. VS Code's onDidSaveTextDocument (and the file watcher) fire on every
// Ctrl+S — including no-op saves, which still rewrite the file and bump its
// mtime. A sha1 of the contents is the only reliable "did this actually change"
// signal. Keyed by absolute local path, persisted per-workspace.
const UPLOAD_HASHES_KEY = "nodemcu.uploadHashes";

function fileContentHash(filePath: string): string | null {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function getUploadHashes(): Record<string, string> {
  return extensionContext?.workspaceState.get<Record<string, string>>(UPLOAD_HASHES_KEY) ?? {};
}

async function saveUploadHashes(hashes: Record<string, string>): Promise<void> {
  if (!extensionContext) return;
  await extensionContext.workspaceState.update(UPLOAD_HASHES_KEY, hashes);
}

/**
 * Decide whether the firmware needs a rebuild+flash for the selected C modules,
 * logging exactly what is going on (issue: the first sync used to silently show
 * only "formatting"/"sync"). Best-effort reads the attached device's boot banner
 * so the user can see which modules the physical device already provides.
 * Returns `ok: true` if it is OK to continue the sync (no build needed, or
 * build+flash succeeded) and `flashed: true` when a flash actually happened so
 * the caller can decide to format the fresh filesystem.
 */
async function ensureFirmwareForSelectedModules(
  fw: string,
  cfg: NodemcuConfig,
  port: string,
  signal?: AbortSignal,
  isFreshWorkspace = false,
): Promise<{ ok: boolean; flashed: boolean }> {
  const selected = Object.entries(cfg.c_modules)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort();

  const buildFlashAndReport = async (): Promise<{ ok: boolean; flashed: boolean }> => {
    await buildAndFlashForSync(signal);
    const ok = statusEmitter.getState() === "success";
    return { ok, flashed: ok };
  };

  const info = await serialSessionManager.withPortReleased(
    port,
    async () => await readDeviceFirmwareInfo({ port, baud: getConfiguredBaud(cfg), signal }),
  );
  if (info) {
    outputChannel.appendLine(
      `Device is running NodeMCU ${info.version ?? "(unknown version)"} with ${info.modules.length} module(s): ${info.modules.join(", ")}.`,
    );
    if (isFreshWorkspace && !info.version) {
      outputChannel.appendLine("Fresh workspace: device banner did not identify NodeMCU firmware — building and flashing firmware...");
      return await buildFlashAndReport();
    }
    const deviceModules = new Set(info.modules.map((m) => m.toLowerCase()));
    const missing = selected.filter((m) => !deviceModules.has(m.toLowerCase()));
    if (missing.length === 0) {
      outputChannel.appendLine(`All ${selected.length} selected C module(s) are already present on the device.`);
    } else {
      outputChannel.appendLine(`Selected C module(s) not yet on the device firmware: ${missing.join(", ")}.`);
      outputChannel.appendLine("Device firmware does not match selected C modules — rebuilding and flashing before sync...");
      return await buildFlashAndReport();
    }
  } else {
    outputChannel.appendLine("Could not read the device firmware banner (port busy or not running NodeMCU).");
    if (isFreshWorkspace) {
      outputChannel.appendLine("Fresh workspace: no NodeMCU banner — building and flashing firmware...");
      return await buildFlashAndReport();
    }
    outputChannel.appendLine("Continuing without banner check.");
  }

  const headerPath = userModulesHeader(fw);
  if (!isCModulesConfigChanged(headerPath, cfg)) {
    outputChannel.appendLine("Selected C modules already match the built firmware — skipping build & flash; syncing Lua only.");
    return { ok: true, flashed: false };
  }
  outputChannel.appendLine("Selected C modules differ from the built firmware — rebuilding and flashing before sync...");
  return await buildFlashAndReport();
}

async function mirrorSrcToDevice(opts: { changedOnly: boolean; forceFormat?: boolean; signal?: AbortSignal }): Promise<void> {
  let cfg = getConfigOrNull();
  if (!cfg) {
    return;
  }
  // The console is a convenience here; a failed connect must not abort the
  // sync (the *WithFallback helpers reopen the session themselves).
  await focusAndConnectSerialConsole().catch((err) => {
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Serial console connect failed before sync: ${err}`);
    return null;
  });
  const srcDir = getConfiguredSrcDir(cfg);
  if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    vscode.window.showWarningMessage("This workspace is not a valid NodeMCU project. Run 'NodeMCU: Initialize Project' first.");
    updateProjectContext();
    return;
  }
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Mirroring src/ to device...`);
  setStatus("uploading", `preparing sync...`);

  const python = getPythonPath();
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync step: selecting serial port...`);
  const port = await ensurePort(cfg);
  if (!port) {
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync aborted: no serial port selected.`);
    return;
  }
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync step: using ${port}.`);

  const isFreshWorkspace = cfg.devices.uuids.length === 0;
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync step: resolving firmware path...`);
  const fw = await getFirmwarePath();
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync step: firmware ${fw ? fw : "unavailable"}.`);
  let flashedDuringCheck = false;
  if (fw) {
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync step: checking selected C modules against device firmware...`);
    const check = await ensureFirmwareForSelectedModules(fw, cfg, port, opts.signal, isFreshWorkspace);
    if (!check.ok) {
      outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync aborted: firmware check/build failed.`);
      setStatus("error", "sync aborted");
      vscode.window.showErrorMessage("Build and flash failed. Sync aborted.");
      return;
    }
    flashedDuringCheck = check.flashed;
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync step: firmware check complete.`);
  }

  // Flashing claims the device (ensureKnownDevice runs before esptool), which
  // rewrites nodemcu.ini. Re-read it so this pass doesn't operate on a stale
  // snapshot and re-claim (and re-format for) the same device.
  if (flashedDuringCheck) {
    cfg = getConfigOrNull() ?? cfg;
  }

  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync step: identifying attached device...`);
  const identity = await ensureKnownDevice(cfg, port, opts.signal);
  if (!identity.allowed) {
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync aborted: device identity was not allowed.`);
    setStatus("error", "sync aborted");
    return;
  }
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync step: device ${identity.identity?.macAddress ?? "unknown"} accepted.`);

  const toolOpts = { python, port, baud: getConfiguredBaud(cfg), baudUpload: cfg.nodemcu.upload_baud, compile: false, signal: opts.signal };
  if (opts.forceFormat || identity.isNew || (flashedDuringCheck && isFreshWorkspace)) {
    setStatus("uploading", `formatting ${port}...`);
    const formatted = await formatWithFallback(toolOpts);
    if (!formatted.success) {
      setStatus("error", "format FAILED");
      vscode.window.showErrorMessage(`Device filesystem format failed: ${formatted.error}`);
      return;
    }
  }

  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync step: listing device files...`);
  const remote = await listFilesWithFallback(toolOpts, false);
  if (!remote.success) {
    setStatus("error", "sync FAILED");
    vscode.window.showErrorMessage(`Unable to list device files before sync: ${remote.error}`);
    return;
  }
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Sync step: listed ${(remote.files ?? []).length} device file(s).`);

  const uploadTimestamps = extensionContext
    ? extensionContext.workspaceState.get<Record<string, number>>("nodemcu.uploadTimestamps") || {}
    : {};
  const uploadHashes = getUploadHashes();
  // With LFS enabled, the bound Lua modules belong in the flash store, not
  // SPIFFS. Excluding them here drops them from the upload set and schedules any
  // existing SPIFFS copy for removal; the LFS image is pushed by deployLfsImage.
  const lfsNames = await lfsBoundNames(cfg, fw);
  const plan = planMirrorSync({
    srcDir,
    remoteFiles: remote.files ?? [],
    uploadTimestamps,
    uploadHashes,
    hashFile: fileContentHash,
    changedOnly: opts.changedOnly && !opts.forceFormat && !identity.isNew,
    excludeRemoteName: lfsNames.size ? (name) => isLfsBoundRemoteName(name, lfsNames) : undefined,
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
      const hash = fileContentHash(file.localPath);
      if (hash) uploadHashes[file.localPath] = hash;
      continue;
    }
    failCount++;
    outputChannel.appendLine(`Failed to upload ${file.remoteName}: ${uploaded.error}`);
  }

  // A removed remote file has no local content to track anymore.
  for (const remoteName of plan.remove) {
    const localPath = path.join(srcDir, remoteName);
    delete uploadHashes[localPath];
    delete uploadTimestamps[localPath];
  }

  if (extensionContext) {
    await extensionContext.workspaceState.update("nodemcu.uploadTimestamps", uploadTimestamps);
    await saveUploadHashes(uploadHashes);
  }

  if (fw) {
    const mod = await reconcileLuaModulesOnDevice(toolOpts, cfg, fw, remote.files ?? []);
    successCount += mod.uploaded + mod.removed;
    failCount += mod.failed;
  }

  if (successCount > 0) {
    await resetWithFallback(toolOpts);
  }
  if (failCount > 0) {
    setStatus("error", `sync FAILED (${failCount} errors)`);
    vscode.window.showErrorMessage(`Synced ${successCount} operation(s), ${failCount} failed.`);
  } else if (successCount > 0) {
    updateSyncTimestamp();
    setStatus("success", `synced ${successCount} operation(s) to ${port}`);
  }
}

function updateSyncTimestamp(): void {
  const iniPath = existingIniPath();
  if (!iniPath) return;
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const timestamp = new Date().toISOString();
  cfg.sync.last_timestamp = timestamp;
  cachedConfig = cfg;
  saveConfig(iniPath, cfg);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Updated sync timestamp: ${timestamp}`);
}

type DeviceToolOpts = { python: string; port: string; baud: number; baudUpload: number; signal?: AbortSignal };

/**
 * Make the device's compiled Lua modules (`<name>.lc`) match the enabled set in
 * `nodemcu.ini`: upload enabled local modules that are missing or changed, and
 * remove `<name>.lc` for modules that are no longer enabled. This folds the old
 * manual "Sync Lua Modules to Device" step into the normal upload paths, so a
 * user who checks a module in the side panel just has it work on next save.
 * `remoteFiles` (when already listed by the caller) avoids an extra device read.
 */
async function reconcileLuaModulesOnDevice(
  toolOpts: DeviceToolOpts,
  cfg: NodemcuConfig,
  fw: string,
  remoteFiles?: FileEntry[],
): Promise<{ uploaded: number; removed: number; failed: number }> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return { uploaded: 0, removed: 0, failed: 0 };

  const resolved = await resolveAllLuaModules(workspaceRoot, fw, cfg);
  const enabledLocal = resolved.filter((m) => !m.isRemote && m.exists);
  const enabledNames = new Set(enabledLocal.map((m) => m.name));

  let entries = remoteFiles;
  if (!entries) {
    const listed = await listFilesWithFallback({ ...toolOpts, compile: false }, false);
    entries = listed.success ? listed.files ?? [] : [];
  }
  const fileNames = entries.map((f) => f.name);
  const remoteSet = new Set(fileNames);

  const moduleTs = extensionContext
    ? extensionContext.workspaceState.get<Record<string, number>>("nodemcu.moduleTimestamps") || {}
    : {};

  let uploaded = 0;
  let removed = 0;
  let failed = 0;

  const lfsOn = isLfsEnabled(cfg);
  for (const m of enabledLocal) {
    const localPath = m.resolvedLocalPath!;
    if (!fs.existsSync(localPath)) continue;
    const remoteName = `${m.name}.lc`;
    if (lfsOn) {
      // The module is in the flash store; drop any SPIFFS copy so require() does
      // not resolve it from the filesystem (which would bypass LFS). The image
      // itself is pushed by deployLfsImage.
      if (remoteSet.has(remoteName)) {
        const rr = await removeWithFallback({ ...toolOpts, compile: false }, remoteName);
        if (rr.success) removed++;
        else { failed++; outputChannel.appendLine(`Failed to remove SPIFFS copy of LFS module ${m.name}: ${rr.error}`); }
      }
      continue;
    }
    const mtime = fs.statSync(localPath).mtimeMs;
    if (remoteSet.has(remoteName) && moduleTs[localPath] === mtime) continue; // present & unchanged
    setStatus("uploading", `syncing module ${m.name}...`);
    const r = await uploadWithFallback({ ...toolOpts, compile: true }, localPath, remoteName);
    if (r.success) {
      uploaded++;
      moduleTs[localPath] = mtime;
    } else {
      failed++;
      outputChannel.appendLine(`Failed to sync module ${m.name}: ${r.error}`);
    }
  }

  // Remove modules that were synced before but are no longer enabled.
  const allModuleNames = new Set((await listLuaModulesFromFirmware(fw)).map((m) => m.name));
  for (const remoteName of fileNames) {
    const match = /^(.+)\.lc$/.exec(remoteName);
    if (!match) continue;
    const name = match[1];
    if (!allModuleNames.has(name) || enabledNames.has(name)) continue;
    setStatus("uploading", `removing module ${name}...`);
    const rr = await removeWithFallback({ ...toolOpts, compile: false }, remoteName);
    if (rr.success) removed++;
    else {
      failed++;
      outputChannel.appendLine(`Failed to remove module ${name}: ${rr.error}`);
    }
  }

  if (extensionContext) {
    await extensionContext.workspaceState.update("nodemcu.moduleTimestamps", moduleTs);
  }
  if (uploaded || removed) {
    outputChannel.appendLine(`Lua modules reconciled: ${uploaded} synced, ${removed} removed.`);
  }
  return { uploaded, removed, failed };
}

async function doUploadSingleFile(uri: vscode.Uri, cfg: NodemcuConfig, signal?: AbortSignal): Promise<void> {
  const srcDir = getConfiguredSrcDir(cfg);
  if (!srcDir) return;
  await focusAndConnectSerialConsole();

  const remoteName = path.relative(srcDir, uri.fsPath).replace(/\\/g, "/");
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Uploading ${remoteName}...`);

  const fw = await getFirmwarePath();
  if (fw) {
    const headerPath = userModulesHeader(fw);
    if (isCModulesConfigChanged(headerPath, cfg)) {
      // Reflashing firmware wipes the device filesystem, so a single-file upload
      // would leave every other src/ file (and Lua module) missing. Fall back to
      // a full mirror, which rebuilds+flashes and then re-uploads all of src/.
      outputChannel.appendLine("C modules changed — reflashing and re-mirroring full src/ (device filesystem is wiped on flash)...");
      await mirrorSrcToDevice({ changedOnly: false, signal });
      return;
    }
  }

  // With LFS enabled, a saved module that belongs to the flash store must not be
  // uploaded to SPIFFS (it would shadow the LFS copy). Skip it and tell the user
  // to redeploy the image; init.lua and non-LFS files keep the normal path.
  if (fw && isLfsEnabled(cfg) && path.basename(uri.fsPath).toLowerCase() !== "init.lua") {
    const base = path.basename(uri.fsPath).replace(/\.lua$/i, "").toLowerCase();
    if ((await lfsBoundNames(cfg, fw)).has(base)) {
      outputChannel.appendLine(`${remoteName} is an LFS module; run "NodeMCU: Build & Deploy LFS Image" to update it on the device.`);
      setStatus("success", `${remoteName}: LFS module — run Build & Deploy LFS to update`);
      return;
    }
  }

  const python = getPythonPath();
  const port = await ensurePort(cfg);
  if (!port) return;
  const identity = await ensureKnownDevice(cfg, port, signal);
  if (!identity.allowed) return;

  const toolOpts = { python, port, baud: getConfiguredBaud(cfg), baudUpload: cfg.nodemcu.upload_baud, compile: false, signal };

  setStatus("uploading", `uploading ${remoteName}...`);
  const result = await uploadWithFallback(toolOpts, uri.fsPath, remoteName);
  if (!result.success) {
    setStatus("error", `upload FAILED: ${remoteName}`);
    outputChannel.appendLine(`Failed to upload ${remoteName}: ${result.error}`);
    return;
  }
  outputChannel.appendLine(`Uploaded ${remoteName}`);
  const uploadedHash = fileContentHash(uri.fsPath);
  if (uploadedHash) {
    const hashes = getUploadHashes();
    hashes[uri.fsPath] = uploadedHash;
    await saveUploadHashes(hashes);
  }

  if (fw) {
    const mod = await reconcileLuaModulesOnDevice(toolOpts, cfg, fw);
    if (mod.failed > 0) {
      setStatus("error", `${remoteName} uploaded, but ${mod.failed} module(s) failed to sync`);
    }
  }

  await resetWithFallback(toolOpts);
  updateSyncTimestamp();
  setStatus("success", `uploaded ${remoteName}`);
}

async function handleFileDelete(event: vscode.FileDeleteEvent): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  if (!cfg.sync.last_timestamp) return;
  await focusAndConnectSerialConsole();

  const srcDir = getConfiguredSrcDir(cfg);
  if (!srcDir) return;

  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Handling file deletion...`);

  await commandQueue.enqueue("Delete file", async (signal) => {
    const python = getPythonPath();
    const port = await ensurePort(cfg);
    if (!port) return;
    const identity = await ensureKnownDevice(cfg, port, signal);
    if (!identity.allowed) return;

    const toolOpts = { python, port, baud: getConfiguredBaud(cfg), baudUpload: cfg.nodemcu.upload_baud, compile: false, signal };

    for (const uri of event.files) {
      if (uri.scheme !== "file") continue;
      const rel = path.relative(srcDir, uri.fsPath);
      if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const remoteName = rel.replace(/\\/g, "/");
      setStatus("uploading", `removing ${remoteName}...`);
      const result = await removeWithFallback(toolOpts, remoteName);
      if (result.success) {
        const hashes = getUploadHashes();
        if (uri.fsPath in hashes) {
          delete hashes[uri.fsPath];
          await saveUploadHashes(hashes);
        }
        updateSyncTimestamp();
        outputChannel.appendLine(`Removed ${remoteName}`);
      } else {
        outputChannel.appendLine(`Failed to remove ${remoteName}: ${result.error}`);
      }
    }
  });
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
  await focusAndConnectSerialConsole();
  const port = await ensurePort(cfg);
  if (!port) return;
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
  const python = getPythonPath();
  setStatus("uploading", `running ${remoteName}...`);
  const opts = { python, port, baud: getConfiguredBaud(cfg), baudUpload: cfg.nodemcu.upload_baud, compile: false, signal };
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
  await focusAndConnectSerialConsole();
  const port = await ensurePort(cfg);
  if (!port) return;
  const python = getPythonPath();
  setStatus("uploading", `resetting device...`);
  const opts = { python, port, baud: getConfiguredBaud(cfg), baudUpload: cfg.nodemcu.upload_baud, compile: false, signal };
  const r = await resetWithFallback(opts);
  if (!r.success) {
    setStatus("error", "reset FAILED");
    vscode.window.showErrorMessage(`Failed to reset device: ${r.error}`);
    return;
  }
  setStatus("success", `reset device`);
  vscode.window.showInformationMessage(`Reset device successfully.`);
}

/**
 * Compile the project's Lua into an LFS image and load it onto the device.
 * Sources = enabled local `[lua_modules]` plus `src/*.lua` (init.lua stays the
 * SPIFFS bootstrap). Assumes the firmware already has the LFS partition and
 * luac.cross has been built (callers run a build first).
 */
/**
 * Lua sources that go into the LFS image: enabled local `[lua_modules]` plus
 * `src/*.lua` (excluding init.lua, which stays the SPIFFS bootstrap). De-duped by
 * module name (basename); `[lua_modules]` wins over a same-named src/ file.
 */
async function collectLfsSources(cfg: NodemcuConfig, fw: string, workspaceRoot: string): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  const addFile = (p: string): void => {
    const base = path.basename(p).replace(/\.lua$/i, "").toLowerCase();
    if (seen.has(base)) return;
    seen.add(base);
    files.push(p);
  };
  const resolved = await resolveAllLuaModules(workspaceRoot, fw, cfg);
  for (const m of resolved) {
    if (!m.isRemote && m.exists && m.resolvedLocalPath) addFile(m.resolvedLocalPath);
  }
  const srcDir = getConfiguredSrcDir(cfg);
  if (srcDir && fs.existsSync(srcDir)) {
    for (const entry of fs.readdirSync(srcDir)) {
      if (!entry.toLowerCase().endsWith(".lua") || entry.toLowerCase() === "init.lua") continue;
      addFile(path.join(srcDir, entry));
    }
  }
  return files;
}

/**
 * Lowercase module basenames bound to LFS (no extension). When LFS is enabled,
 * these must NOT also live in SPIFFS — otherwise `require` resolves the SPIFFS
 * copy and the flash store is bypassed. Empty when LFS is off.
 */
async function lfsBoundNames(cfg: NodemcuConfig, fw: string | null): Promise<Set<string>> {
  if (!isLfsEnabled(cfg) || !fw) return new Set();
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return new Set();
  const set = new Set<string>();
  for (const f of await collectLfsSources(cfg, fw, workspaceRoot)) {
    set.add(path.basename(f).replace(/\.lua$/i, "").toLowerCase());
  }
  return set;
}

/** A SPIFFS remote file (e.g. `greet.lc`/`greet.lua`) whose basename is LFS-bound. */
function isLfsBoundRemoteName(remoteName: string, names: Set<string>): boolean {
  const base = remoteName.replace(/\.(lua|lc)$/i, "").toLowerCase();
  return /\.(lua|lc)$/i.test(remoteName) && names.has(base);
}

async function deployLfsImage(signal?: AbortSignal): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = await getFirmwarePath();
  if (!cfg || !fw) return;
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const luac = luacCrossPath(fw);
  // The build path is fixed and flavour-agnostic, so the binary there may be a
  // stale luac.cross left from a previous lua_version / number-model (e.g. a
  // lua51 prebuilt downloaded before the user switched to lua53). Trust it only
  // when its marker — or, for an unmarked legacy binary, its `-v` output —
  // confirms the current flavour; otherwise refresh from the flavour-keyed
  // prebuilt cache. Using the wrong flavour silently emits an LFS image the
  // device rejects ("invalid header in precompiled chunk").
  const desiredFlavour = luacFlavour(cfg);
  const luacMatches = await installedLuacMatchesFlavour(luac, desiredFlavour, currentPrebuiltTarget());
  if (!luacMatches) {
    // No usable local build (e.g. the user has no host C compiler, or the binary
    // at this path is for a different flavour). Fetch the prebuilt matching the
    // current Lua flavour + host target. resolvePrebuiltLuacCross keys its cache
    // by flavour, so each flavour is downloaded once and coexists; installPrebuilt
    // populates the same path the local build would, so the rest of the pipeline
    // is unchanged.
    if (fs.existsSync(luac)) {
      const installedFlavour = readInstalledLuacFlavour(luac);
      outputChannel.appendLine(
        `[lfs-prebuilt] luac.cross at ${luac} is not ${desiredFlavour}` +
          `${installedFlavour ? ` (marked ${installedFlavour})` : " (unmarked legacy binary)"}; refreshing.`,
      );
    }
    setStatus("building", "fetching prebuilt luac.cross...");
    const prebuilt = await resolvePrebuiltLuacCross(cfg, {
      storageRoot: extensionContext.globalStorageUri.fsPath,
      onProgress: (m) => outputChannel.appendLine(`[lfs-prebuilt] ${m}`),
      signal,
    });
    if (prebuilt) {
      try {
        await installPrebuiltLuacCross(prebuilt, fw);
        outputChannel.appendLine(`[lfs-prebuilt] installed ${prebuilt.cachedPath} -> ${luacCrossPath(fw)}`);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to install prebuilt luac.cross: ${err instanceof Error ? err.message : String(err)}. ` +
            "Install a host C compiler (gcc/clang) and re-run Enable LFS so the firmware build can produce it locally.",
        );
        setStatus("error", "LFS image FAILED", String(err));
        return;
      }
    } else {
      vscode.window.showErrorMessage(
        "luac.cross was not built (no host C compiler when the firmware was configured) and the prebuilt download did not succeed. " +
          "Cannot build the LFS image. Install a host C compiler (gcc/clang) and re-run Enable LFS, or check your network connection.",
      );
      setStatus("error", "LFS image FAILED", "no luac.cross (local or prebuilt)");
      return;
    }
  }

  const files = await collectLfsSources(cfg, fw, workspaceRoot);
  if (files.length === 0) {
    vscode.window.showInformationMessage("No Lua modules or src/*.lua files to put into LFS.");
    return;
  }

  setStatus("building", "building LFS image...");
  const outPath = lfsImagePath(fw);
  const img = await buildLfsImage(new Shell(), {
    luacCross: luac,
    files,
    outPath,
    maxSize: cfg.build.lfs_size,
    onLog: (s) => outputChannel.append(s),
    onStderr: (s) => outputChannel.append(s),
    signal,
  });
  if (!img.success) {
    setStatus("error", "LFS image FAILED", img.error);
    vscode.window.showErrorMessage(`LFS image build failed: ${img.error}`);
    return;
  }

  const serial = await focusAndConnectSerialConsole({ force: true });
  if (!serial) {
    vscode.window.showErrorMessage("No serial connection available to deploy the LFS image.");
    return;
  }
  setStatus("uploading", "uploading LFS image...");
  const bytes = fs.readFileSync(outPath);
  const up = await serial.client.uploadContent(new Uint8Array(bytes), "lfs.img", { signal });
  if (!up.success) {
    setStatus("error", "LFS upload FAILED", up.error);
    vscode.window.showErrorMessage(`Failed to upload LFS image: ${up.error}`);
    return;
  }
  setStatus("flashing", "flash-reloading LFS...");
  const fr = await serial.client.flashReload("lfs.img");
  if (!fr.success) {
    setStatus("error", "flashreload FAILED", fr.error);
    vscode.window.showErrorMessage(`node.flashreload failed: ${fr.error}`);
    return;
  }

  // The modules now live in the flash store, so drop any SPIFFS copies (a prior
  // mirror/sync may have uploaded them) — otherwise `require` would resolve the
  // SPIFFS `.lc`/`.lua` instead of the LFS version. init.lua stays in SPIFFS.
  const names = new Set(files.map((f) => path.basename(f).replace(/\.lua$/i, "").toLowerCase()));
  const port = await ensurePort(cfg);
  if (port) {
    const toolOpts = { python: getPythonPath(), port, baud: getConfiguredBaud(cfg), baudUpload: cfg.nodemcu.upload_baud, compile: false, signal };
    const listed = await listFilesWithFallback(toolOpts, false);
    for (const f of listed.success ? listed.files ?? [] : []) {
      if (isLfsBoundRemoteName(f.name, names)) {
        await removeWithFallback(toolOpts, f.name);
        outputChannel.appendLine(`Removed SPIFFS copy of LFS module: ${f.name}`);
      }
    }
  }

  setStatus("success", `LFS deployed (${files.length} module(s))`);
  vscode.window.showInformationMessage(`LFS image deployed: ${files.length} module(s) now run from flash.`);
}

/** Enable LFS (allocate the partition), reflash firmware, then deploy the image. */
async function doEnableLfs(signal?: AbortSignal): Promise<void> {
  const cfg = getConfigOrNull();
  const iniPath = existingIniPath();
  if (!cfg || !iniPath) {
    vscode.window.showErrorMessage("No nodemcu.ini found. Run 'NodeMCU: Initialize Project' first.");
    return;
  }
  if (!isLfsEnabled(cfg)) {
    // Re-read at write time so we don't clobber concurrent edits (AGENTS rule).
    const live = getConfigOrNull() ?? cfg;
    const next: NodemcuConfig = { ...live, build: { ...live.build, lfs_size: DEFAULT_LFS_SIZE } };
    cachedConfig = next;
    saveConfig(iniPath, next);
    refreshAll();
  }
  // Allocating the partition changes the firmware layout, so reflash, then load
  // the image into the new flash store.
  await doBuildAndFlash(signal);
  if (statusEmitter.getState() === "error" || signal?.aborted) return;
  await deployLfsImage(signal);
}

/** Disable LFS: free the partition and reflash firmware without LFS. */
async function doDisableLfs(signal?: AbortSignal): Promise<void> {
  const cfg = getConfigOrNull();
  const iniPath = existingIniPath();
  if (!cfg || !iniPath) return;
  if (isLfsEnabled(cfg)) {
    const live = getConfigOrNull() ?? cfg;
    const next: NodemcuConfig = { ...live, build: { ...live.build, lfs_size: 0 } };
    cachedConfig = next;
    saveConfig(iniPath, next);
    refreshAll();
  }
  await doBuildAndFlash(signal);
}

/** Rebuild + redeploy the LFS image (no firmware reflash when the partition is unchanged). */
async function doBuildAndDeployLfs(signal?: AbortSignal): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) {
    vscode.window.showErrorMessage("No nodemcu.ini found. Run 'NodeMCU: Initialize Project' first.");
    return;
  }
  if (!isLfsEnabled(cfg)) {
    vscode.window.showErrorMessage("LFS is not enabled. Run 'NodeMCU: Enable LFS' first.");
    return;
  }
  // Incremental: ensures luac.cross + firmware are current (no-op if up to date).
  await doBuild(signal);
  if (statusEmitter.getState() === "error" || signal?.aborted) return;
  await deployLfsImage(signal);
}

async function doSyncLuaModules(signal?: AbortSignal): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = await getFirmwarePath();
  if (!cfg || !fw) return;
  await focusAndConnectSerialConsole();
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  const resolved = await resolveAllLuaModules(workspaceRoot, fw, cfg);
  const local = resolved.filter((m) => !m.isRemote && m.exists);
  if (local.length === 0) {
    vscode.window.showInformationMessage("No local Lua modules to sync.");
    return;
  }
  const python = getPythonPath();
  const port = await ensurePort(cfg);
  if (!port) return;
  const identity = await ensureKnownDevice(cfg, port, signal);
  if (!identity.allowed) return;
  for (const m of local) {
    setStatus("uploading", `uploading ${m.name}...`);
    const r = await uploadWithFallback(
      { python, port, baud: getConfiguredBaud(cfg), baudUpload: cfg.nodemcu.upload_baud, compile: true, signal },
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
  luaDiagnostics?.refreshAll();
  await doSyncLuaModules(signal);
}

/** Quick-fix: enable a C module referenced from Lua that isn't in [c_modules]. */
function doEnableCModuleFromFix(name: string): void {
  const cfg = getConfigOrNull();
  const iniPath = existingIniPath();
  if (!cfg || !iniPath) {
    vscode.window.showWarningMessage(`No nodemcu.ini found to enable C module "${name}".`);
    return;
  }
  const newCfg = setCModule(cfg, name, true);
  cachedConfig = newCfg;
  saveConfig(iniPath, newCfg);
  refreshAll();
  luaDiagnostics?.refreshAll();
  vscode.window.showInformationMessage(`Enabled C module "${name}" in nodemcu.ini. Rebuild the firmware to apply.`);
}

/** Quick-fix: enable a Lua module required() but missing from [lua_modules]. */
async function doEnableLuaModuleFromFix(signal: AbortSignal | undefined, name: string): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) {
    vscode.window.showWarningMessage(`No nodemcu.ini found to enable Lua module "${name}".`);
    return;
  }
  let source = `lua_modules/${name}/${name}.lua`;
  const fw = await getFirmwarePath();
  if (fw) {
    const mod = (await listLuaModulesFromFirmware(fw)).find((m) => m.name === name);
    if (mod) source = luaModuleSource(mod, cfg.nodemcu);
  }
  await doAcceptLuaModuleCompletion(signal, name, source);
}

/**
 * Quick-fix: add a font to the firmware's compiled font table. When the
 * nodemcu.ini section is still empty we first seed it with the fonts currently
 * baked into the firmware header, so adding one font never drops the defaults.
 */
function enableFontFromFix(section: GraphicsSection, module: "u8g2" | "ucg", headerPath: string, kind: Parameters<typeof readActiveEntries>[1], name: string): void {
  const cfg = getConfigOrNull();
  const iniPath = existingIniPath();
  if (!cfg || !iniPath) {
    vscode.window.showWarningMessage(`No nodemcu.ini found to add font "${name}".`);
    return;
  }
  const seed = readActiveEntries(headerPath, kind);
  // Compiling a font is pointless unless its display library is also built in,
  // so make sure the C module is enabled alongside the font entry.
  const newCfg = setCModule(setGraphicsEntry(cfg, section, name, true, seed), module, true);
  cachedConfig = newCfg;
  saveConfig(iniPath, newCfg);
  refreshAll();
  luaDiagnostics?.refreshAll();
  vscode.window.showInformationMessage(`Added font "${name}" to [${section}]. Rebuild the firmware to compile it in.`);
}

async function doEnableU8g2FontFromFix(name: string): Promise<void> {
  const fw = await getFirmwarePath();
  if (!fw) return;
  enableFontFromFix("u8g2_fonts", "u8g2", u8g2FontsHeader(fw), "u8g2Font", name);
}

async function doEnableUcgFontFromFix(name: string): Promise<void> {
  const fw = await getFirmwarePath();
  if (!fw) return;
  enableFontFromFix("ucg_fonts", "ucg", ucgConfigHeader(fw), "ucgFont", name);
}

async function doUploadAndMonitor(signal?: AbortSignal): Promise<void> {
  await focusAndConnectSerialConsole();
  await doUploadChanges(signal);
  if (statusEmitter.getState() === "error") return;
  await focusAndConnectSerialConsole();
}

async function doRegenerateLuaApi(): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = await getFirmwarePath();
  if (!cfg || !fw) return;
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Regenerating Lua API files from firmware...`);
  try {
    const modules = await mapFirmwareAPI(fw);
    const apiPath = path.join(workspaceRoot, ".vscode", "nodemcu-api.lua");
    const stubContent = generateEmmyLuaStub(modules);
    fs.mkdirSync(path.dirname(apiPath), { recursive: true });
    fs.writeFileSync(apiPath, stubContent, "utf-8");

    const luaDirs = [luaModulesDir(fw), path.join(workspaceRoot, "lua")];
    writeLuaRc({ workspaceRoot, luaModulesDirs: luaDirs, apiFile: apiPath });
    vscode.window.showInformationMessage(`Generated ${apiPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to regenerate Lua API: ${msg}`);
  }
}

async function doMapFirmware(): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) {
    vscode.window.showErrorMessage("No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first.");
    return;
  }
  const fw = await getFirmwarePath();
  if (!fw) return;
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Mapping firmware C and Lua modules...`);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "NodeMCU: Mapping Firmware API", cancellable: false },
    async () => {
      try {
        const modules = await mapFirmwareAPI(fw);
        const reportPath = path.join(workspaceRoot, "firmware_map.md");
        const reportContent = generateMarkdownReport(modules);
        fs.writeFileSync(reportPath, reportContent, "utf-8");

        const apiPath = path.join(workspaceRoot, ".vscode", "nodemcu-api.lua");
        const stubContent = generateEmmyLuaStub(modules);
        fs.mkdirSync(path.dirname(apiPath), { recursive: true });
        fs.writeFileSync(apiPath, stubContent, "utf-8");

        const luaDirs = [luaModulesDir(fw), path.join(workspaceRoot, "lua")];
        writeLuaRc({ workspaceRoot, luaModulesDirs: luaDirs, apiFile: apiPath });

        const doc = await vscode.workspace.openTextDocument(reportPath);
        await vscode.window.showTextDocument(doc);

        vscode.window.showInformationMessage("Mapped firmware API: created firmware_map.md and updated .vscode/nodemcu-api.lua");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to map firmware: ${msg}`);
      }
    }
  );
}

async function doAddLuaModule(item?: { module: LuaModuleInfo }): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = await getFirmwarePath();
  if (!cfg) {
    vscode.window.showErrorMessage("No nodemcu.ini found in workspace. Run 'NodeMCU: Initialize Project' first.");
    return;
  }
  if (!fw) return;
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
  const selectedFile = selectMainFileForConfig(pick.module, cfg.nodemcu);
  const newCfg = setLuaModule(cfg, pick.module.name, `lua_modules/${pick.module.dirName}/${path.basename(selectedFile)}`);
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
    nextCfg.lua_modules[item.module.name] = `lua_modules/${item.module.dirName}/${path.basename(item.module.mainFile)}`;
  }
  const iniPath = existingIniPath();
  if (iniPath) {
    cachedConfig = nextCfg;
    saveConfig(iniPath, nextCfg);
    refreshAll();
  }
}

async function doToggleCModule(item?: { module: CModuleInfo }): Promise<void> {
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
  let newCfg = setCModule(cfg, modulePick.label, !currently);
  // Enabling the tls module pulls in CLIENT_SSL; seed a sensible TLS buffer size
  // in [build] so the user starts from a value that actually completes handshakes.
  if (!currently && modulePick.label.toLowerCase() === "tls") {
    newCfg = { ...newCfg, build: { ...newCfg.build, ssl_buffer_size: TLS_ENABLE_SSL_BUFFER_SIZE } };
  }
  const iniPath = existingIniPath();
  if (iniPath) {
    cachedConfig = newCfg;
    saveConfig(iniPath, newCfg);
    refreshAll();
  }
}

function doRefreshExplorer(): void {
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Refreshing explorer...`);
  refreshAll();
  void refreshDetectedPortsAndMaybeSelect();
}

function doOpenIni(): void {
  const iniPath = getIniPath();
  if (!iniPath) return;
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Opening nodemcu.ini...`);
  vscode.window.showTextDocument(vscode.Uri.file(iniPath));
}

export async function closeSerialMonitors(): Promise<ClosedSerialMonitor[]> {
  return [];
}

export async function restoreSerialMonitors(monitors: ClosedSerialMonitor[], signal?: AbortSignal): Promise<void> {
  void monitors;
  void signal;
}

async function doOpenSerialMonitor(_signal?: AbortSignal): Promise<void> {
  await focusAndConnectSerialConsole({ force: true });
}

async function doDisconnectSerialSession(): Promise<void> {
  await setSerialAutoConnectSuppressed(true);
  await serialSessionManager.closeAll();
  await updatePortStatusBar(getConfigOrNull());
}

async function doReleaseSerialPort(): Promise<void> {
  await setSerialAutoConnectSuppressed(true);
  await serialSessionManager.closeAll();
  await updatePortStatusBar(getConfigOrNull());
  vscode.window.showInformationMessage("NodeMCU released the serial port.");
}

async function doReconnectSerialPort(): Promise<void> {
  await focusAndConnectSerialConsole({ force: true });
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
          description: [serialPortDisplayName(p), p.path === selectedPort ? "selected" : ""].filter(Boolean).join(" "),
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
  // Return no children so the `viewsWelcome` contribution (explanatory text +
  // an "Initialize NodeMCU Project" button, like the built-in Git view) renders
  // instead of a bare tree row.
  return new AsyncTreeProvider(async () => []);
}

// Matches when the cursor sits inside the quotes of a `require("…` call.
const REQUIRE_QUOTE_RE = /\brequire\s*\(\s*["'][^"']*$/;

class LuaModuleCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    // Inside require("…") the bare-name completions (RequireCompletionProvider)
    // apply; the top-level `name = require("name")` snippet would be malformed here.
    const prefix = document.lineAt(position).text.slice(0, position.character);
    if (REQUIRE_QUOTE_RE.test(prefix)) return [];
    const fw = await getFirmwarePath();
    if (!fw) return [];
    const cfg = getConfigOrNull();
    const modules = await listLuaModulesFromFirmware(fw);
    return modules.map((m) => createLuaModuleCompletionItem(m, cfg?.nodemcu));
  }
}

/** Bare module names of local `*.lua` files under the configured src/ dir. */
function localSrcLuaModuleNames(): string[] {
  const root = getWorkspaceRoot();
  if (!root) return [];
  const cfg = getConfigOrNull();
  const srcDir = path.join(root, cfg?.nodemcu.src || "src");
  const names = new Set<string>();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".lua")) {
        names.add(e.name.replace(/\.lua$/i, ""));
      }
    }
  };
  walk(srcDir);
  return Array.from(names).sort();
}

/**
 * Completes the module name inside `require("…")` from the firmware Lua module
 * library plus the local `*.lua` files under src/. Inserts the bare name only.
 */
class RequireCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const prefix = document.lineAt(position).text.slice(0, position.character);
    if (!REQUIRE_QUOTE_RE.test(prefix)) return undefined;
    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];
    const add = (name: string, detail: string, sort: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
      item.detail = detail;
      item.insertText = name;
      item.filterText = name;
      item.sortText = `${sort}_${name}`;
      items.push(item);
    };
    for (const name of localSrcLuaModuleNames()) add(name, "local module (src/)", "0");
    const fw = await getFirmwarePath();
    if (fw) {
      for (const m of await listLuaModulesFromFirmware(fw)) add(m.name, "firmware Lua module", "1");
    }
    return items;
  }
}

/**
 * The set of fonts effectively compiled into the firmware for `lib`: the enabled
 * keys of the nodemcu.ini section, or — when that section is empty — the fonts
 * currently active in the firmware header (the shipped defaults the build keeps).
 * Mirrors the diagnostics controller so completion and diagnostics agree.
 */
function effectiveEnabledFonts(cfg: NodemcuConfig, fw: string, lib: FontLib): Set<string> {
  const section = lib === "u8g2" ? cfg.u8g2_fonts : cfg.ucg_fonts;
  const keys = Object.entries(section).filter(([, v]) => v).map(([k]) => k);
  if (keys.length > 0) return new Set(keys);
  const headerPath = lib === "u8g2" ? u8g2FontsHeader(fw) : ucgConfigHeader(fw);
  return new Set(readActiveEntries(headerPath, lib === "u8g2" ? "u8g2Font" : "ucgFont"));
}

/**
 * Completes `u8g2.font_*` / `ucg.font_*` from the firmware's full font catalog.
 * Accepting a font that isn't compiled yet also enables it in nodemcu.ini (via
 * the item's command). The per-firmware catalog (~1100 u8g2 + ~1240 ucg names)
 * is parsed once and cached.
 */
class FontCompletionProvider implements vscode.CompletionItemProvider {
  private readonly cache = new Map<string, { u8g2: string[]; ucg: string[] }>();

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const prefix = document.lineAt(position).text.slice(0, position.character);
    const m = /\b(u8g2|ucg)\.(\w*)$/.exec(prefix);
    if (!m) return undefined;
    const lib = m[1] as FontLib;
    const fw = await getFirmwarePath();
    if (!fw) return undefined;
    const catalog = this.catalogFor(fw);
    const fonts = lib === "u8g2" ? catalog.u8g2 : catalog.ucg;
    if (fonts.length === 0) return undefined;
    const cfg = getConfigOrNull();
    const enabled = cfg ? effectiveEnabledFonts(cfg, fw, lib) : new Set<string>();
    return fonts.map((f) => createFontCompletionItem(lib, f, enabled.has(f)));
  }

  private catalogFor(fw: string): { u8g2: string[]; ucg: string[] } {
    let cached = this.cache.get(fw);
    if (!cached) {
      cached = { u8g2: listU8g2Fonts(fw), ucg: listUcgFonts(fw) };
      this.cache.set(fw, cached);
    }
    return cached;
  }
}

function scheduleSrcSyncUri(uri: vscode.Uri): void {
  const cfg = getConfigOrNull();
  if (!cfg || !isUriUnderSrc(uri, cfg)) return;
  lastSavedUri = uri;
  if (srcSaveTimer) clearTimeout(srcSaveTimer);
  srcSaveTimer = setTimeout(() => {
    srcSaveTimer = undefined;
    const uri = lastSavedUri;
    lastSavedUri = undefined;
    if (!uri) return;
    const currentCfg = getConfigOrNull();
    if (!currentCfg) return;
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] scheduleSrcSync: last_timestamp=${currentCfg.sync.last_timestamp || '(empty)'}`);
    const surfaceError = (what: string) => (err: unknown) => {
      outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${what} failed: ${err instanceof Error ? err.message : err}`);
      setStatus("error", `${what} FAILED`);
      vscode.window.showErrorMessage(`NodeMCU: ${what} failed: ${err instanceof Error ? err.message : err}`);
    };
    if (currentCfg.sync.last_timestamp) {
      // Skip no-op saves: Ctrl+S with no edits still fires this handler, but the
      // bytes are identical to what we last uploaded, so there is nothing to do.
      const hash = fileContentHash(uri.fsPath);
      if (hash && getUploadHashes()[uri.fsPath] === hash) {
        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] File saved but contents unchanged — skipping upload.`);
        return;
      }
      outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] File saved, uploading single file...`);
      commandQueue.enqueue("Upload file", (signal) => doUploadSingleFile(uri, currentCfg, signal)).catch(surfaceError("upload"));
    } else {
      outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] File saved, performing full sync...`);
      commandQueue.enqueue("Sync src/", (signal) => mirrorSrcToDevice({ changedOnly: false, signal })).catch(surfaceError("sync"));
    }
  }, 300);
}

function scheduleSrcSync(document: vscode.TextDocument): void {
  scheduleSrcSyncUri(document.uri);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("NodeMCU");
  managedLuaServer = new ManagedLuaServer();
  void managedLuaServer.start(context);
  serialAutoConnectSuppressed = context.workspaceState.get<boolean>(SERIAL_AUTO_CONNECT_SUPPRESSED_KEY) ?? false;
  void ensurePython(context);
  commandQueue = new CommandQueue();
  statusEmitter = new StatusEmitter();
  serialSessionManager = new SerialSessionManager();
  serialConsoleViewProvider = new SerialConsoleViewProvider(context.extensionUri, serialSessionManager, {
    ensureSession: async () => {
      const cfg = getConfigOrNull();
      if (!cfg) {
        return undefined;
      }
      await ensureSerialSession(cfg);
      return serialSessionManager.getCurrentSession();
    },
    log: (message) => outputChannel?.appendLine(message),
  });
  portStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  portStatusBarItem.command = "nodemcu-vscode.selectPort";
  queueStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  queueStatusBarItem.command = "nodemcu-vscode.cancelQueued";
  commandQueue.on("change", () => updateQueueStatusBar());
  context.subscriptions.push(
    serialSessionManager,
    serialConsoleViewProvider,
    serialSessionManager.onDidChangeSession(() => {
      void updatePortStatusBar(getConfigOrNull());
    }),
    vscode.window.registerWebviewViewProvider("nodemcu.serialConsole", serialConsoleViewProvider),
  );

  context.subscriptions.push(portStatusBarItem, queueStatusBarItem, outputChannel);
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
  // Scope the watcher to the configured src/ directory so the sync only reacts
  // to src/ changes — not to churn in node_modules/, .git/, build output, etc.
  // (onDidSaveTextDocument and the change handlers still defend with
  // isUriUnderSrc, but a scoped watcher avoids waking up for unrelated files.)
  const srcWatchRoot = getWorkspaceRoot();
  const srcSetting =
    vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("src") ||
    getConfigOrNull()?.nodemcu.src ||
    "src";
  const srcFileWatcher = srcWatchRoot
    ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(srcWatchRoot, `${srcSetting}/**`))
    : vscode.workspace.createFileSystemWatcher("**/*");
  context.subscriptions.push(
    luaTreeView,
    cTreeView,
    srcFileWatcher,
    vscode.workspace.onDidSaveTextDocument(scheduleSrcSync),
    srcFileWatcher.onDidChange(scheduleSrcSyncUri),
    srcFileWatcher.onDidCreate(scheduleSrcSyncUri),
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
      const previous = cachedConfig;
      if (previous && previous.nodemcu.firmware_path !== c.nodemcu.firmware_path) {
        cachedFirmwarePath = null;
        luaDiagnostics?.invalidateCatalog();
      }
      const serialConfigChanged = !!previous
        && (previous.nodemcu.port !== c.nodemcu.port || getConfiguredBaud(previous) !== getConfiguredBaud(c));
      if (serialConfigChanged) {
        void serialSessionManager.closeAll();
      }
      cachedConfig = c;
      refreshAll();
      luaDiagnostics?.refreshAll();
      updatePortStatusBar(c);
      if (serialConfigChanged && !serialAutoConnectSuppressed) {
        void focusAndConnectSerialConsole();
      }
    });
    cachedConfig = watcher.current();
    watcher.start();
    if (!serialAutoConnectSuppressed) {
      void focusAndConnectSerialConsole();
    }
  }

  refreshAll();
  void projectTasksProvider.reload();

  luaDiagnostics = new LuaDiagnosticsController({
    getConfig: () => getConfigOrNull(),
    getFirmwarePath: () => getFirmwarePath(),
    log: (m) => outputChannel?.appendLine(m),
  });
  context.subscriptions.push(
    luaDiagnostics,
    vscode.workspace.onDidOpenTextDocument((d) => luaDiagnostics?.onOpen(d)),
    vscode.workspace.onDidChangeTextDocument((e) => luaDiagnostics?.onChange(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => luaDiagnostics?.onClose(d)),
  );
  luaDiagnostics.refreshAll();

  void refreshDetectedPortsAndMaybeSelect();
  portRefreshTimer = setInterval(() => {
    void refreshDetectedPortsAndMaybeSelect();
  }, 5000);
  context.subscriptions.push(new vscode.Disposable(() => {
    if (portRefreshTimer) clearInterval(portRefreshTimer);
    if (srcSaveTimer) clearTimeout(srcSaveTimer);
    lastSavedUri = undefined;
    void serialSessionManager.closeAll();
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
    vscode.commands.registerCommand("nodemcu-vscode.enableLfs", commandWithOperation("Enable LFS", doEnableLfs)),
    vscode.commands.registerCommand("nodemcu-vscode.disableLfs", commandWithOperation("Disable LFS", doDisableLfs)),
    vscode.commands.registerCommand("nodemcu-vscode.buildAndDeployLfs", commandWithOperation("Build & Deploy LFS", doBuildAndDeployLfs)),
    vscode.commands.registerCommand("nodemcu-vscode.acceptLuaModuleCompletion", commandWithOperation("Accept Lua Module", doAcceptLuaModuleCompletion)),
    vscode.commands.registerCommand("nodemcu-vscode.enableCModuleFromFix", doEnableCModuleFromFix),
    vscode.commands.registerCommand("nodemcu-vscode.enableLuaModuleFromFix", commandWithOperation("Enable Lua Module", doEnableLuaModuleFromFix)),
    vscode.commands.registerCommand("nodemcu-vscode.enableU8g2FontFromFix", doEnableU8g2FontFromFix),
    vscode.commands.registerCommand("nodemcu-vscode.enableUcgFontFromFix", doEnableUcgFontFromFix),
    vscode.commands.registerCommand("nodemcu-vscode.openSerialMonitor", doOpenSerialMonitor),
    vscode.commands.registerCommand("nodemcu-vscode.disconnectSerialSession", doDisconnectSerialSession),
    vscode.commands.registerCommand("nodemcu-vscode.releaseSerialPort", doReleaseSerialPort),
    vscode.commands.registerCommand("nodemcu-vscode.reconnectSerialPort", commandWithOperation("Reconnect Serial Port", doReconnectSerialPort)),
    vscode.commands.registerCommand("nodemcu-vscode.cancelQueued", () => {
      commandQueue.cancelPending();
      outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Queued commands cancelled`);
    }),
    vscode.commands.registerCommand("nodemcu-vscode.regenerateLuaApi", doRegenerateLuaApi),
    vscode.commands.registerCommand("nodemcu-vscode.mapFirmware", doMapFirmware),
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
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: "lua" },
      new FontCompletionProvider(),
      ".", ..."_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: "lua" },
      new RequireCompletionProvider(),
      "\"", "'", ..."_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")
    ),
    vscode.languages.registerCodeActionsProvider(
      { language: "lua" },
      new NodemcuLuaCodeActionProvider(),
      { providedCodeActionKinds: NodemcuLuaCodeActionProvider.providedKinds }
    )
  );
}

export async function deactivate(): Promise<void> {
  if (portRefreshTimer) clearInterval(portRefreshTimer);
  watcher?.stop();
  await serialSessionManager?.closeAll();
  if (managedLuaServer) {
    await managedLuaServer.stop();
  }
}
