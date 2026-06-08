import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { Shell } from "./util/shell";
import {
  getLuaModuleEntries,
  loadConfig,
  saveConfig,
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
import { SerialDiscovery, type SerialPort } from "./flash/serialDiscovery";
import { NodemcuTool, type FileEntry, type NodemcuToolOptions } from "./upload/nodemcuTool";
import { DirectSerialUploader } from "./upload/directSerialUploader";
import { StatusEmitter, type BuildState } from "./status/statusBar";
import { listLuaModulesFromFirmware, listCModules, type LuaModuleInfo, type CModuleInfo } from "./luaPicker/moduleList";
import { resolveAllLuaModules, type ResolvedLuaModule } from "./luaPicker/luaModuleResolver";
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

class AsyncTreeProvider implements vscode.TreeDataProvider<TreeItemNode> {
  private _onDidChange = new vscode.EventEmitter<TreeItemNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private cache: TreeItemNode[] = [];

  constructor(private loader: () => Promise<TreeItemNode[]>) {}

  refresh(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
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
  checkboxState?: vscode.TreeItemCheckboxState;
  luaModule?: LuaModuleInfo;
  cModule?: CModuleInfo;
  serialPort?: SerialPort;
  remoteFile?: FileEntry;
}

let deviceExplorerProvider: AsyncTreeProvider;
let luaModulesProvider: AsyncTreeProvider;
let cModulesProvider: AsyncTreeProvider;

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
}

function setStatus(state: BuildState, text: string, detail?: string): void {
  statusEmitter.update({ state, text, detail });
  statusBarItem.text = `$(circuit-board) ${text}`;
  statusBarItem.tooltip = detail ?? text;
  statusBarItem.show();
}

async function updatePortStatusBar(cfg: NodemcuConfig | null) {
  if (!portStatusBarItem) return;
  const port = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("port") || cfg?.nodemcu.port;
  if (!port) {
    let ports: SerialPort[] = [];
    try {
      ports = await new SerialDiscovery(new Shell()).list();
    } catch {
      ports = [];
    }
    if (ports.length === 1) {
      portStatusBarItem.text = `$(plug) ${ports[0].path}`;
      portStatusBarItem.tooltip = "Detected serial port. Click to select it.";
    } else if (ports.length > 1) {
      portStatusBarItem.text = `$(plug) ${ports.length} Ports`;
      portStatusBarItem.tooltip = "Click to select a serial port";
    } else {
      portStatusBarItem.text = `$(plug) No Port`;
      portStatusBarItem.tooltip = "Click to select a serial port";
    }
    portStatusBarItem.show();
    return;
  }

  portStatusBarItem.text = `$(plug) ${port}`;
  portStatusBarItem.tooltip = "Click to select a serial port";
  portStatusBarItem.show();
  
  // Try to find friendly name
  let name = "";
  try {
    const discovery = new SerialDiscovery(new Shell());
    const ports = await discovery.list();
    const p = ports.find(x => x.path === port);
    if (p && p.manufacturer) {
      name = ` (${p.manufacturer})`;
    }
  } catch (e) {}

  portStatusBarItem.text = `$(plug) ${port}${name}`;
  portStatusBarItem.tooltip = "Click to select a serial port";
  portStatusBarItem.show();
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
  let port = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("port") || cfg.nodemcu.port;
  if (port) return port;
  const discovery = new SerialDiscovery(new Shell());
  const ports = await discovery.list();
  if (ports.length === 1) {
    cfg.nodemcu.port = ports[0].path;
    const iniPath = getIniPath();
    if (iniPath) saveConfig(iniPath, cfg);
    updatePortStatusBar(cfg);
    refreshAll();
    return ports[0].path;
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

async function doBuild(): Promise<void> {
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

function getFilesRecursively(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === "." || file === "..") continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file === ".git" || file === "node_modules" || file === ".vscode" || file === ".tmp-user-dir" || file === ".tmp-extensions") {
        continue;
      }
      results = results.concat(getFilesRecursively(fullPath));
    } else if (stat.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

async function pickWorkspaceFile(): Promise<vscode.Uri | null> {
  const picks = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Upload" });
  return picks?.[0] ?? null;
}

function isFilesystemError(error: string | undefined): boolean {
  return !!error && (error.includes("unable to open file") || error.includes("index global 'file'"));
}

function shouldUseDirectSerialFallback(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return [
    "cannot open port",
    "unable to establish connection",
    "access denied",
    "cannot write",
    "cannot flush",
    "cannot upload transfer helper",
    "cannot write chunk",
    "data transfer failed",
    "prompt",
    "timed out",
    "timeout",
    "serial",
  ].some((fragment) => e.includes(fragment));
}

async function uploadWithFallback(
  tool: NodemcuTool,
  opts: NodemcuToolOptions,
  localPath: string,
  remoteName: string,
): Promise<{ success: boolean; error?: string }> {
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

  if (!r.success && shouldUseDirectSerialFallback(r.error)) {
    outputChannel.appendLine(`\nnodemcu-tool upload failed (${r.error}). Retrying with direct serial uploader...`);
    const direct = new DirectSerialUploader();
    r = await direct.upload(opts, localPath, remoteName, (s) => outputChannel.append(s));
  }

  return r;
}

async function resetWithFallback(tool: NodemcuTool, opts: NodemcuToolOptions): Promise<void> {
  const direct = new DirectSerialUploader();
  const directReset = await direct.hardReset(opts, (s) => outputChannel.append(s));
  if (directReset.success) return;
  outputChannel.appendLine(`Direct serial reset failed (${directReset.error}). Retrying with nodemcu-tool reset...`);
  const r = await tool.reset(opts, (s) => outputChannel.append(s));
  if (r.success) return;
  if (!shouldUseDirectSerialFallback(r.error)) {
    outputChannel.appendLine(`Reset failed: ${r.error}`);
    return;
  }
  outputChannel.appendLine(`Reset via nodemcu-tool failed: ${r.error}`);
}

async function doUploadFile(uri?: vscode.Uri): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;

  const workspaceRoot = getWorkspaceRoot();
  const fw = await getFirmwarePath();

  if (fw) {
    const headerPath = userModulesHeader(fw);
    if (isCModulesConfigChanged(headerPath, cfg)) {
      outputChannel.appendLine("C modules configuration has changed. Rebuilding and flashing firmware first...");
      await doBuildAndFlash();
      if (statusEmitter.getState() !== "success") {
        vscode.window.showErrorMessage("Build and flash failed. Upload aborted.");
        return;
      }
    }
  }

  // Determine files to upload
  const filesToUpload: { localPath: string; remoteName: string }[] = [];
  let isAutoUpload = false;
  let srcSetting = "src";

  if (uri) {
    filesToUpload.push({ localPath: uri.fsPath, remoteName: path.basename(uri.fsPath) });
  } else if (vscode.window.activeTextEditor) {
    const editorUri = vscode.window.activeTextEditor.document.uri;
    filesToUpload.push({ localPath: editorUri.fsPath, remoteName: path.basename(editorUri.fsPath) });
  } else {
    srcSetting = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("src") || cfg.nodemcu.src || "src";
    const srcDir = workspaceRoot ? path.resolve(workspaceRoot, srcSetting) : null;

    if (srcDir && fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      isAutoUpload = true;
      const srcFiles = getFilesRecursively(srcDir);

      let localModules: ResolvedLuaModule[] = [];
      if (fw && workspaceRoot) {
        const resolved = await resolveAllLuaModules(workspaceRoot, fw, cfg);
        localModules = resolved.filter((m) => !m.isRemote && m.exists);
      }

      const seen = new Set<string>();
      for (const file of srcFiles) {
        if (!seen.has(file)) {
          seen.add(file);
          const rel = path.relative(srcDir, file).replace(/\\/g, "/");
          filesToUpload.push({ localPath: file, remoteName: rel });
        }
      }
      for (const m of localModules) {
        const file = m.resolvedLocalPath!;
        if (!seen.has(file)) {
          seen.add(file);
          filesToUpload.push({ localPath: file, remoteName: path.basename(file) });
        }
      }
      if (workspaceRoot) {
        const initLuaPath = path.join(workspaceRoot, "init.lua");
        if (fs.existsSync(initLuaPath) && !seen.has(initLuaPath)) {
          seen.add(initLuaPath);
          filesToUpload.push({ localPath: initLuaPath, remoteName: "init.lua" });
        }
      }
    } else {
      const picked = await pickWorkspaceFile();
      if (!picked) return;
      filesToUpload.push({ localPath: picked.fsPath, remoteName: path.basename(picked.fsPath) });
      vscode.window.showInformationMessage("Tip: Set a 'src' folder or configure 'nodemcu-vscode.src' in settings to track and upload modified files automatically.");
    }
  }

  let changedFiles = filesToUpload;
  if (isAutoUpload) {
    const uploadTimestamps = extensionContext
      ? extensionContext.workspaceState.get<Record<string, number>>("nodemcu.uploadTimestamps") || {}
      : {};

    changedFiles = filesToUpload.filter((f) => {
      if (!fs.existsSync(f.localPath)) return false;
      const mtime = fs.statSync(f.localPath).mtimeMs;
      const lastMtime = uploadTimestamps[f.localPath] ?? 0;
      return mtime > lastMtime;
    });

    if (changedFiles.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        `No files changed in '${srcSetting}'. Upload all files anyway?`,
        "Yes",
        "No"
      );
      if (choice !== "Yes") {
        outputChannel.appendLine("No files have changed since last upload. Upload cancelled.");
        return;
      }
      changedFiles = filesToUpload;
    }
  }

  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const tool = new NodemcuTool(new Shell());
  if (!(await tool.isInstalled(python))) {
    const ok = await ensureNodemcuTool(python);
    if (!ok) return;
  }
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();

  let successCount = 0;
  let failCount = 0;

  // Removed tool.reset() here to prevent Windows COM port locking. nodemcu-tool already resets on connect.

  setStatus("uploading", `Uploading ${changedFiles.length} file(s)...`);

  const uploadTimestamps = extensionContext
    ? extensionContext.workspaceState.get<Record<string, number>>("nodemcu.uploadTimestamps") || {}
    : {};

  for (const file of changedFiles) {
    if (!fs.existsSync(file.localPath)) continue;
    outputChannel.appendLine(`Uploading ${file.localPath} as ${file.remoteName}...`);
    const opts = { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false };
    const r = await uploadWithFallback(tool, opts, file.localPath, file.remoteName);

    if (r.success) {
      successCount++;
      const mtime = fs.statSync(file.localPath).mtimeMs;
      uploadTimestamps[file.localPath] = mtime;
    } else {
      failCount++;
      outputChannel.appendLine(`Failed to upload ${file.remoteName}: ${r.error}`);
    }
  }

  if (extensionContext) {
    await extensionContext.workspaceState.update("nodemcu.uploadTimestamps", uploadTimestamps);
  }

  // Backwards compatible lua modules upload for single init.lua file
  if (!isAutoUpload && changedFiles.length === 1 && changedFiles[0].remoteName === "init.lua") {
    if (fw && workspaceRoot) {
      const resolved = await resolveAllLuaModules(workspaceRoot, fw, cfg);
      const local = resolved.filter((m) => !m.isRemote && m.exists);
      for (const m of local) {
        outputChannel.appendLine(`Uploading Lua module ${m.name} alongside init.lua...`);
        const r = await uploadWithFallback(
          tool,
          { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false },
          m.resolvedLocalPath!,
          path.basename(m.resolvedLocalPath!),
        );
        if (r.success) {
          successCount++;
        } else {
          failCount++;
          outputChannel.appendLine(`Failed to upload Lua module ${m.name}: ${r.error}`);
        }
      }
    }
  }

  if (successCount > 0) {
    setStatus("uploading", `Resetting device to apply changes...`);
    await resetWithFallback(tool, { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false });
  }

  if (failCount > 0) {
    setStatus("error", `upload FAILED (${failCount} errors)`);
    vscode.window.showErrorMessage(`Uploaded ${successCount} files, ${failCount} failed.`);
  } else {
    setStatus("success", `uploaded ${successCount} files`);
    vscode.window.showInformationMessage(`Successfully uploaded ${successCount} file(s).`);
  }
}

async function doUploadChanges(): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;

  const workspaceRoot = getWorkspaceRoot();
  const fw = await getFirmwarePath();

  if (fw) {
    const headerPath = userModulesHeader(fw);
    if (isCModulesConfigChanged(headerPath, cfg)) {
      outputChannel.appendLine("C modules configuration has changed. Rebuilding and flashing firmware first...");
      await doBuildAndFlash();
      if (statusEmitter.getState() !== "success") {
        vscode.window.showErrorMessage("Build and flash failed. Upload aborted.");
        return;
      }
    }
  }

  const srcSetting = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("src") || cfg.nodemcu.src || "src";
  const srcDir = workspaceRoot ? path.resolve(workspaceRoot, srcSetting) : null;

  if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    vscode.window.showWarningMessage(`Source directory '${srcSetting}' does not exist or is not a directory.`);
    return;
  }

  const srcFiles = getFilesRecursively(srcDir);
  let localModules: ResolvedLuaModule[] = [];
  if (fw && workspaceRoot) {
    const resolved = await resolveAllLuaModules(workspaceRoot, fw, cfg);
    localModules = resolved.filter((m) => !m.isRemote && m.exists);
  }

  const filesToUpload: { localPath: string; remoteName: string }[] = [];
  const seen = new Set<string>();
  for (const file of srcFiles) {
    if (!seen.has(file)) {
      seen.add(file);
      const rel = path.relative(srcDir, file).replace(/\\/g, "/");
      filesToUpload.push({ localPath: file, remoteName: rel });
    }
  }
  for (const m of localModules) {
    const file = m.resolvedLocalPath!;
    if (!seen.has(file)) {
      seen.add(file);
      filesToUpload.push({ localPath: file, remoteName: path.basename(file) });
    }
  }
  if (workspaceRoot) {
    const initLuaPath = path.join(workspaceRoot, "init.lua");
    if (fs.existsSync(initLuaPath) && !seen.has(initLuaPath)) {
      seen.add(initLuaPath);
      filesToUpload.push({ localPath: initLuaPath, remoteName: "init.lua" });
    }
  }

  const uploadTimestamps = extensionContext
    ? extensionContext.workspaceState.get<Record<string, number>>("nodemcu.uploadTimestamps") || {}
    : {};

  const changedFiles = filesToUpload.filter((f) => {
    if (!fs.existsSync(f.localPath)) return false;
    const mtime = fs.statSync(f.localPath).mtimeMs;
    const lastMtime = uploadTimestamps[f.localPath] ?? 0;
    return mtime > lastMtime;
  });

  if (changedFiles.length === 0) {
    outputChannel.appendLine("All files are up to date.");
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
  await closeSerialMonitors();

  let successCount = 0;
  let failCount = 0;

  // Removed tool.reset() here to prevent Windows COM port locking.

  setStatus("uploading", `Uploading ${changedFiles.length} file(s)...`);

  for (const file of changedFiles) {
    if (!fs.existsSync(file.localPath)) continue;
    outputChannel.appendLine(`Uploading ${file.localPath} as ${file.remoteName}...`);
    const opts = { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false };
    const r = await uploadWithFallback(tool, opts, file.localPath, file.remoteName);

    if (r.success) {
      successCount++;
      const mtime = fs.statSync(file.localPath).mtimeMs;
      uploadTimestamps[file.localPath] = mtime;
    } else {
      failCount++;
      outputChannel.appendLine(`Failed to upload ${file.remoteName}: ${r.error}`);
    }
  }

  if (extensionContext) {
    await extensionContext.workspaceState.update("nodemcu.uploadTimestamps", uploadTimestamps);
  }

  if (successCount > 0) {
    setStatus("uploading", `Resetting device to apply changes...`);
    await resetWithFallback(tool, { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false });
  }

  if (failCount > 0) {
    setStatus("error", `upload FAILED (${failCount} errors)`);
    vscode.window.showErrorMessage(`Uploaded ${successCount} files, ${failCount} failed.`);
  } else {
    setStatus("success", `uploaded ${successCount} files`);
    vscode.window.showInformationMessage(`Successfully uploaded ${successCount} file(s).`);
  }
}

async function doDownloadFile(item?: { remoteFile?: FileEntry }): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  const remoteName = item?.remoteFile?.name;
  if (!remoteName) {
    vscode.window.showErrorMessage("Select a file in Device Explorer to download.");
    return;
  }
  const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(getWorkspaceRoot() ?? os.homedir(), remoteName)) });
  if (!destination) return;
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const tool = new NodemcuTool(new Shell());
  if (!(await tool.isInstalled(python)) && !(await ensureNodemcuTool(python))) return;
  setStatus("uploading", `downloading ${remoteName}...`);
  const r = await tool.download(
    { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false },
    remoteName,
    destination.fsPath,
    (s) => outputChannel.append(s),
  );
  if (r.success) {
    setStatus("success", `downloaded ${remoteName}`);
    vscode.window.showInformationMessage(`Downloaded ${remoteName}`);
  } else {
    setStatus("error", "download FAILED");
    vscode.window.showErrorMessage(`Download failed: ${r.error}`);
  }
}

async function doDeleteFile(item?: { remoteFile?: FileEntry }): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  const remoteName = item?.remoteFile?.name;
  if (!remoteName) {
    vscode.window.showErrorMessage("Select a file in Device Explorer to delete.");
    return;
  }
  const choice = await vscode.window.showWarningMessage(`Delete ${remoteName} from device?`, "Delete", "Cancel");
  if (choice !== "Delete") return;
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const tool = new NodemcuTool(new Shell());
  if (!(await tool.isInstalled(python)) && !(await ensureNodemcuTool(python))) return;
  setStatus("uploading", `deleting ${remoteName}...`);
  const r = await tool.remove(
    { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false },
    remoteName,
    (s) => outputChannel.append(s),
  );
  if (r.success) {
    setStatus("success", `deleted ${remoteName}`);
    refreshAll();
    vscode.window.showInformationMessage(`Deleted ${remoteName}`);
  } else {
    setStatus("error", "delete FAILED");
    vscode.window.showErrorMessage(`Delete failed: ${r.error}`);
  }
}

async function doRunFile(item?: { remoteFile?: FileEntry; module?: LuaModuleInfo }): Promise<void> {
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
  const tool = new NodemcuTool(new Shell());
  if (!(await tool.isInstalled(python)) && !(await ensureNodemcuTool(python))) return;
  setStatus("uploading", `running ${remoteName}...`);
  const r = await tool.runFile(
    { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false },
    remoteName,
    (s) => outputChannel.append(s),
  );
  if (r.success) {
    setStatus("success", `ran ${remoteName}`);
    vscode.window.showInformationMessage(`Ran ${remoteName}`);
  } else {
    setStatus("error", "run FAILED");
    vscode.window.showErrorMessage(`Failed to run ${remoteName}: ${r.error}`);
  }
}

async function doResetDevice(): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
  const tool = new NodemcuTool(new Shell());
  if (!(await tool.isInstalled(python)) && !(await ensureNodemcuTool(python))) return;
  setStatus("uploading", `resetting device...`);
  const opts = { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false };
  const r = await tool.reset(opts, (s) => outputChannel.append(s));
  if (!r.success && shouldUseDirectSerialFallback(r.error)) {
    const direct = new DirectSerialUploader();
    const fallback = await direct.hardReset(opts, (s) => outputChannel.append(s));
    if (fallback.success) {
      setStatus("success", `reset device`);
      vscode.window.showInformationMessage(`Reset device successfully.`);
      return;
    }
  }
  if (!r.success) {
    setStatus("error", "reset FAILED");
    vscode.window.showErrorMessage(`Failed to reset device: ${r.error}`);
    return;
  }
  setStatus("success", `reset device`);
  vscode.window.showInformationMessage(`Reset device successfully.`);
}

async function doSyncLuaModules(): Promise<void> {
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
  const tool = new NodemcuTool(new Shell());
  if (!(await tool.isInstalled(python))) {
    const ok = await ensureNodemcuTool(python);
    if (!ok) return;
  }
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  for (const m of local) {
    setStatus("uploading", `uploading ${m.name}...`);
    const r = await uploadWithFallback(
      tool,
      { python, port, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: true },
      m.resolvedLocalPath!,
      m.name + ".lc",
    );
    if (!r.success) {
      vscode.window.showErrorMessage(`Failed to upload ${m.name}: ${r.error}`);
    }
  }
  setStatus("success", `synced ${local.length} module(s)`);
}

async function doRegenerateLuaApi(): Promise<void> {
  const cfg = getConfigOrNull();
  const fw = await getFirmwarePath();
  if (!cfg || !fw) return;
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;
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
  updatePortStatusBar(getConfigOrNull());
  deviceExplorerProvider?.refresh();
}

function doOpenIni(): void {
  const iniPath = getIniPath();
  if (!iniPath) return;
  vscode.window.showTextDocument(vscode.Uri.file(iniPath));
}

export async function closeSerialMonitors() {
  const monitors = vscode.window.terminals.filter(t => t.name.startsWith("NodeMCU: "));
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
}

async function doOpenSerialMonitor(): Promise<void> {
  const cfg = getConfigOrNull();
  if (!cfg) return;
  const port = await ensurePort(cfg);
  if (!port) return;
  await closeSerialMonitors();
  const term = vscode.window.createTerminal({ name: `NodeMCU: ${port}` });
  term.show();
  const baud = cfg.nodemcu.baud;
  term.sendText(`python -m serial.tools.miniterm "${port}" ${baud}`);
}

function buildDeviceExplorerProvider(): AsyncTreeProvider {
  return new AsyncTreeProvider(async () => {
    const cfg = getConfigOrNull();
    const configuredPort = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("port") || cfg?.nodemcu.port || "";
    const ports = await new SerialDiscovery(new Shell()).list();
    const selectedPort = configuredPort || (ports.length === 1 ? ports[0].path : "");
    const portChildren: TreeItemNode[] = ports.length === 0
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

    const fileChildren: TreeItemNode[] = [];
    if (!cfg) {
      fileChildren.push({
        id: "device-no-config",
        label: "No nodemcu.ini found",
        description: "Initialize or open a NodeMCU project",
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: new vscode.ThemeIcon("warning"),
      });
    } else if (!selectedPort) {
      fileChildren.push({
        id: "device-no-selected-port",
        label: "Select a serial port",
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        iconPath: new vscode.ThemeIcon("plug"),
        command: { command: "nodemcu-vscode.selectPort", title: "Select Port" },
      });
    } else {
      const python = vscode.workspace.getConfiguration("nodemcu-vscode").get<string>("pythonPath") ?? "python";
      const tool = new NodemcuTool(new Shell());
      if (await tool.isInstalled(python)) {
        const files = await tool.listFiles(
          { python, port: selectedPort, baud: cfg.nodemcu.baud, baudUpload: cfg.nodemcu.upload_baud, compile: false },
          (s) => outputChannel.append(s),
        );
        if (files.length === 0) {
          fileChildren.push({
            id: "device-empty-files",
            label: "No files found",
            description: "or unable to connect",
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            iconPath: new vscode.ThemeIcon("warning"),
          });
        } else {
          fileChildren.push(...files.map((f) => ({
            id: `device-file-${f.name}`,
            label: f.name,
            description: `${f.size} bytes`,
            collapsibleState: vscode.TreeItemCollapsibleState.None,
            contextValue: "nodemcu.deviceFile",
            iconPath: new vscode.ThemeIcon("file"),
            remoteFile: f,
          })));
        }
      } else {
        fileChildren.push({
          id: "device-tool-missing",
          label: "nodemcu-tool is not installed",
          description: "Upload or sync will install it",
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          iconPath: new vscode.ThemeIcon("warning"),
        });
      }
    }

    return [
      {
        id: "device-ports",
        label: "Serial Ports",
        description: ports.length ? `${ports.length} detected` : "none detected",
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        contextValue: "nodemcu.devicePorts",
        iconPath: new vscode.ThemeIcon("plug"),
        children: portChildren,
      },
      {
        id: "device-files",
        label: "Device Files",
        description: selectedPort ? selectedPort : "select a port",
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        contextValue: "nodemcu.deviceFiles",
        iconPath: new vscode.ThemeIcon("folder"),
        children: fileChildren,
      },
    ];
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
    {
      id: "task-build",
      label: "Build Firmware",
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon("tools"),
      command: { command: "nodemcu-vscode.build", title: "Build" },
    },
    {
      id: "task-flash",
      label: "Flash Firmware",
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon("zap"),
      command: { command: "nodemcu-vscode.flash", title: "Flash" },
    },
    {
      id: "task-build-flash",
      label: "Build & Flash",
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon("rocket"),
      command: { command: "nodemcu-vscode.buildAndFlash", title: "Build & Flash" },
    },
    {
      id: "task-upload",
      label: "Upload File to Device",
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon("cloud-upload"),
      command: { command: "nodemcu-vscode.uploadFile", title: "Upload" },
    },
    {
      id: "task-upload-changes",
      label: "Upload Changes",
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon("cloud-upload"),
      command: { command: "nodemcu-vscode.uploadChanges", title: "Upload Changes" },
    },
    {
      id: "task-sync-lua",
      label: "Sync Lua Modules",
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon("sync"),
      command: { command: "nodemcu-vscode.syncLuaModules", title: "Sync Lua Modules" },
    },
  ]);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("NodeMCU");
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
  const projectTasksProvider = buildProjectTasksProvider();
  
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
  context.subscriptions.push(luaTreeView, cTreeView);

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
  
  updatePortStatusBar(cachedConfig);

  context.subscriptions.push(
    vscode.commands.registerCommand("nodemcu-vscode.initProject", doInitProject),
    vscode.commands.registerCommand("nodemcu-vscode.build", doBuild),
    vscode.commands.registerCommand("nodemcu-vscode.flash", doFlash),
    vscode.commands.registerCommand("nodemcu-vscode.buildAndFlash", doBuildAndFlash),
    vscode.commands.registerCommand("nodemcu-vscode.uploadFile", doUploadFile),
    vscode.commands.registerCommand("nodemcu-vscode.uploadChanges", doUploadChanges),
    vscode.commands.registerCommand("nodemcu-vscode.downloadFile", doDownloadFile),
    vscode.commands.registerCommand("nodemcu-vscode.deleteFile", doDeleteFile),
    vscode.commands.registerCommand("nodemcu-vscode.runFile", doRunFile),
    vscode.commands.registerCommand("nodemcu-vscode.resetDevice", doResetDevice),
    vscode.commands.registerCommand("nodemcu-vscode.syncLuaModules", doSyncLuaModules),
    vscode.commands.registerCommand("nodemcu-vscode.regenerateLuaApi", doRegenerateLuaApi),
    vscode.commands.registerCommand("nodemcu-vscode.addLuaModule", doAddLuaModule),
    vscode.commands.registerCommand("nodemcu-vscode.toggleLuaModule", doToggleLuaModule),
    vscode.commands.registerCommand("nodemcu-vscode.toggleCModule", doToggleCModule),
    vscode.commands.registerCommand("nodemcu-vscode.refreshExplorer", doRefreshExplorer),
    vscode.commands.registerCommand("nodemcu-vscode.openIni", doOpenIni),
    vscode.commands.registerCommand("nodemcu-vscode.openSerialMonitor", doOpenSerialMonitor),
    vscode.commands.registerCommand("nodemcu-vscode.selectPort", doSelectPort),
    vscode.languages.registerCompletionItemProvider(
      { language: "ini", pattern: "**/nodemcu.ini" },
      new IniCompletionItemProvider(),
      "[", "="
    )
  );

}

export function deactivate(): void {
  watcher?.stop();
}
