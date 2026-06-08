import * as path from "node:path";
import * as vscode from "vscode";

export const LIVE_EDIT_SCHEME = "nodemcu-live";

export interface LiveEditMetadata {
  port: string;
  remoteName: string;
}

interface LiveEntry {
  content: Uint8Array;
  metadata: LiveEditMetadata;
  mtime: number;
}

export class LiveEditFileSystemProvider implements vscode.FileSystemProvider {
  private readonly entries = new Map<string, LiveEntry>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  makeUri(metadata: LiveEditMetadata): vscode.Uri {
    const safePort = encodeURIComponent(metadata.port);
    const safeRemote = metadata.remoteName.split("/").map(encodeURIComponent).join("/");
    return vscode.Uri.parse(`${LIVE_EDIT_SCHEME}:/${safePort}/${safeRemote}`);
  }

  setDocument(metadata: LiveEditMetadata, content: Uint8Array): vscode.Uri {
    const uri = this.makeUri(metadata);
    this.entries.set(this.key(uri), { content, metadata, mtime: Date.now() });
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    return uri;
  }

  getMetadata(uri: vscode.Uri): LiveEditMetadata | undefined {
    return this.entries.get(this.key(uri))?.metadata;
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.entries.get(this.key(uri));
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: vscode.FileType.File,
      ctime: entry.mtime,
      mtime: entry.mtime,
      size: entry.content.byteLength,
    };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const entry = this.entries.get(this.key(uri));
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return entry.content;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const existing = this.entries.get(this.key(uri));
    const metadata = existing?.metadata ?? this.metadataFromUri(uri);
    this.entries.set(this.key(uri), { content, metadata, mtime: Date.now() });
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(_uri: vscode.Uri): void {
    // The provider is flat and materializes files through setDocument().
  }

  delete(uri: vscode.Uri): void {
    this.entries.delete(this.key(uri));
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const entry = this.entries.get(this.key(oldUri));
    if (!entry) throw vscode.FileSystemError.FileNotFound(oldUri);
    this.entries.delete(this.key(oldUri));
    this.entries.set(this.key(newUri), { ...entry, metadata: this.metadataFromUri(newUri), mtime: Date.now() });
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  watch(_uri: vscode.Uri): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  private key(uri: vscode.Uri): string {
    return uri.toString();
  }

  private metadataFromUri(uri: vscode.Uri): LiveEditMetadata {
    const parts = uri.path.replace(/^\/+/, "").split("/");
    const port = decodeURIComponent(parts.shift() ?? "");
    const remoteName = parts.map(decodeURIComponent).join("/") || path.basename(uri.path);
    return { port, remoteName };
  }
}
