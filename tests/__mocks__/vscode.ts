/**
 * Minimal runtime mock of the "vscode" module for unit tests.
 *
 * Only the APIs actually used by src/device/liveEditFs.ts are implemented.
 * This file is referenced via vitest's moduleNameMapper so it takes effect
 * whenever any test-imported module does  `import * as vscode from "vscode"`.
 */

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------
export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  private constructor(
    scheme: string,
    authority: string,
    path: string,
    query = "",
    fragment = "",
  ) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  static parse(value: string): Uri {
    // Minimal RFC-3986-ish parser good enough for nodemcu-live:/<port>/<file>
    const schemeEnd = value.indexOf(":");
    const scheme = schemeEnd >= 0 ? value.slice(0, schemeEnd) : "";
    const rest = value.slice(schemeEnd + 1);
    const withoutFragment = rest.split("#")[0];
    const [pathAndQuery] = withoutFragment.split("?");
    return new Uri(scheme, "", pathAndQuery ?? "", "", "");
  }

  static file(fsPath: string): Uri {
    return new Uri("file", "", fsPath.replace(/\\/g, "/"));
  }

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }

  get fsPath(): string {
    return this.path;
  }

  with(change: Partial<{ scheme: string; authority: string; path: string; query: string; fragment: string }>): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
}

// ---------------------------------------------------------------------------
// EventEmitter
// ---------------------------------------------------------------------------
export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  get event(): (listener: (e: T) => void) => Disposable {
    return (listener) => {
      this.listeners.push(listener);
      return new Disposable(() => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      });
    };
  }

  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }

  dispose(): void {
    this.listeners = [];
  }
}

// ---------------------------------------------------------------------------
// Disposable
// ---------------------------------------------------------------------------
export class Disposable {
  constructor(private readonly _dispose: () => void) {}
  dispose(): void {
    this._dispose();
  }
  static from(...disposables: { dispose(): void }[]): Disposable {
    return new Disposable(() => disposables.forEach((d) => d.dispose()));
  }
}

// ---------------------------------------------------------------------------
// FileSystemError
// ---------------------------------------------------------------------------
export class FileSystemError extends Error {
  static FileNotFound(msgOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(`FileNotFound: ${msgOrUri?.toString() ?? ""}`);
  }
  static FileExists(msgOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(`FileExists: ${msgOrUri?.toString() ?? ""}`);
  }
  static FileNotADirectory(msgOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(`FileNotADirectory: ${msgOrUri?.toString() ?? ""}`);
  }
  static FileIsADirectory(msgOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(`FileIsADirectory: ${msgOrUri?.toString() ?? ""}`);
  }
  static NoPermissions(msgOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(`NoPermissions: ${msgOrUri?.toString() ?? ""}`);
  }
  static Unavailable(msgOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(`Unavailable: ${msgOrUri?.toString() ?? ""}`);
  }
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const FileChangeType = {
  Changed: 1,
  Created: 2,
  Deleted: 3,
} as const;

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;
