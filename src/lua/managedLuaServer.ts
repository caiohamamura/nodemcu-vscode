import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import * as vscode from "vscode";
import type { LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";

export const LUA_LSP_VERSION = "3.18.2";

export interface ManagedLspTarget {
  platform: "win32" | "linux" | "darwin";
  arch: "x64" | "arm64" | "ia32";
  ext: "zip" | "tar.gz";
}

export function currentLspTarget(): ManagedLspTarget {
  let platform: "win32" | "linux" | "darwin" = "linux";
  if (os.platform() === "win32") {
    platform = "win32";
  } else if (os.platform() === "darwin") {
    platform = "darwin";
  }

  let arch: "x64" | "arm64" | "ia32" = "x64";
  const osArch = os.arch();
  if (osArch === "arm64") {
    arch = "arm64";
  } else if (osArch === "ia32" && platform === "win32") {
    arch = "ia32";
  }

  const ext = platform === "win32" ? "zip" : "tar.gz";
  return { platform, arch, ext };
}

export function getLspBinaryPath(storageRoot: string): string {
  const isWindows = os.platform() === "win32";
  const binaryName = isWindows ? "lua-language-server.exe" : "lua-language-server";
  return path.join(storageRoot, "lua-language-server", LUA_LSP_VERSION, "bin", binaryName);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

async function downloadFile(url: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }
  const fileStream = fs.createWriteStream(outputPath);
  await finished(Readable.fromWeb(response.body as any).pipe(fileStream));
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await ensureDir(destDir);
  const isZip = archivePath.toLowerCase().endsWith(".zip");
  if (!isZip) {
    child_process.execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "pipe" });
    return;
  }
  try {
    child_process.execFileSync("tar", ["-xf", archivePath, "-C", destDir], { stdio: "pipe" });
  } catch {
    const extractZip = (await import("extract-zip")).default;
    await extractZip(archivePath, { dir: destDir });
  }
}

export async function ensureManagedLuaServer(
  storageRoot: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const binaryPath = getLspBinaryPath(storageRoot);
  if (await exists(binaryPath)) {
    return binaryPath;
  }

  const target = currentLspTarget();
  const assetName = `lua-language-server-${LUA_LSP_VERSION}-${target.platform}-${target.arch}.${target.ext}`;
  const downloadUrl = `https://github.com/LuaLS/lua-language-server/releases/download/${LUA_LSP_VERSION}/${assetName}`;

  const destDir = path.dirname(path.dirname(binaryPath));
  const tempRoot = path.join(storageRoot, "lua-language-server", ".download-temp");
  await ensureDir(tempRoot);
  const archivePath = path.join(tempRoot, assetName);

  try {
    onProgress?.(`Downloading Lua Language Server (${LUA_LSP_VERSION})...`);
    await downloadFile(downloadUrl, archivePath, signal);

    onProgress?.(`Extracting Lua Language Server...`);
    await extractArchive(archivePath, destDir);

    if (os.platform() !== "win32") {
      await fsp.chmod(binaryPath, 0o755).catch(() => {});
      // Also chmod the wrapper script if it exists in the main folder
      const wrapperPath = path.join(destDir, "bin", "lua-language-server");
      if (await exists(wrapperPath)) {
        await fsp.chmod(wrapperPath, 0o755).catch(() => {});
      }
    }

    if (!(await exists(binaryPath))) {
      throw new Error("Extracted archive did not contain lua-language-server binary.");
    }

    return binaryPath;
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export class ManagedLuaServer {
  private client: LanguageClient | null = null;
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel("NodeMCU Lua Server");
  }

  async start(context: vscode.ExtensionContext): Promise<void> {
    if (this.client) {
      return;
    }

    const storageRoot = process.env.NODEMCU_VSCODE_STORAGE_ROOT || context.globalStorageUri.fsPath;
    let binaryPath = "";

    try {
      binaryPath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "NodeMCU: Lua Language Server Setup",
          cancellable: true,
        },
        async (progress, token) => {
          const abortController = new AbortController();
          token.onCancellationRequested(() => abortController.abort());
          return await ensureManagedLuaServer(
            storageRoot,
            (message) => progress.report({ message }),
            abortController.signal
          );
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`Failed to setup managed Lua Language Server: ${message}`);
      vscode.window.showErrorMessage(`Failed to setup managed Lua Language Server: ${message}`);
      return;
    }

    this.outputChannel.appendLine(`Starting Lua Language Server from: ${binaryPath}`);

    const { LanguageClient, TransportKind } = await import("vscode-languageclient/node");

    const serverOptions: ServerOptions = {
      run: { command: binaryPath, transport: TransportKind.stdio },
      debug: { command: binaryPath, transport: TransportKind.stdio },
    };

    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: "file", language: "lua" }],
      outputChannel: this.outputChannel,
    };

    const client = new LanguageClient(
      "nodemcuLuaLS",
      "NodeMCU Lua Language Server",
      serverOptions,
      clientOptions
    );
    this.client = client;

    try {
      await client.start();
      this.outputChannel.appendLine("Lua Language Server started successfully.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`Failed to start Lua Language Server: ${message}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.client) {
      return;
    }
    this.outputChannel.appendLine("Stopping Lua Language Server...");
    try {
      await this.client.stop();
      this.outputChannel.appendLine("Lua Language Server stopped.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`Failed to stop Lua Language Server: ${message}`);
    } finally {
      this.client = null;
    }
  }
}
