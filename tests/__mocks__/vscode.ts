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

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;

export const TreeItemCheckboxState = {
  Unchecked: 0,
  Checked: 1,
} as const;

export class ThemeIcon {
  constructor(readonly id: string) {}
}

// ---------------------------------------------------------------------------
// Diagnostics / code actions
// ---------------------------------------------------------------------------
export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const;

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
    this.start = new Position(startLine, startChar);
    this.end = new Position(endLine, endChar);
  }
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  constructor(readonly range: Range, readonly message: string, readonly severity?: number) {}
}

export class CodeActionKind {
  private constructor(readonly value: string) {}
  static readonly QuickFix = new CodeActionKind("quickfix");
}

export class CodeAction {
  diagnostics?: Diagnostic[];
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(readonly title: string, readonly kind?: CodeActionKind) {}
}

export class TreeItem {
  description?: string;
  contextValue?: string;
  iconPath?: ThemeIcon;
  command?: unknown;
  resourceUri?: Uri;
  checkboxState?: number;

  constructor(readonly label: string, readonly collapsibleState?: number) {}
}

export const window = {
  terminals: [] as Array<{
    name: string;
    processId?: Promise<number | undefined>;
    sendText(text: string, addNewLine?: boolean): void;
    dispose(): void;
    show?(): void;
  }>,
  createdTerminals: [] as Array<{
    name: string;
    shellPath?: string;
    shellArgs?: string[];
    sent: Array<{ text: string; addNewLine?: boolean }>;
    shown: boolean;
    disposed: boolean;
    processId: Promise<number | undefined>;
    sendText(text: string, addNewLine?: boolean): void;
    dispose(): void;
    show(): void;
  }>,
  createTerminal(options: { name: string; shellPath?: string; shellArgs?: string[] }) {
    const terminal = {
      name: options.name,
      shellPath: options.shellPath,
      shellArgs: options.shellArgs,
      sent: [] as Array<{ text: string; addNewLine?: boolean }>,
      shown: false,
      disposed: false,
      processId: Promise.resolve(undefined),
      sendText(text: string, addNewLine?: boolean): void {
        this.sent.push({ text, addNewLine });
      },
      dispose(): void {
        this.disposed = true;
      },
      show(): void {
        this.shown = true;
      },
    };
    this.createdTerminals.push(terminal);
    this.terminals.push(terminal);
    return terminal;
  },
  createOutputChannel() {
    return {
      append(): void {},
      appendLine(): void {},
      show(): void {},
      dispose(): void {},
    };
  },
  createStatusBarItem() {
    return {
      text: "",
      tooltip: "",
      command: "",
      show(): void {},
      dispose(): void {},
    };
  },
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showOpenDialog: async () => undefined,
  showSaveDialog: async () => undefined,
  showQuickPick: async () => undefined,
  showTextDocument: async () => undefined,
  registerTreeDataProvider(): Disposable {
    return new Disposable(() => {});
  },
  createTreeView() {
    return {
      onDidChangeSelection(): Disposable {
        return new Disposable(() => {});
      },
      onDidChangeCheckboxState(): Disposable {
        return new Disposable(() => {});
      },
      dispose(): void {},
    };
  },
  withProgress: async (_options: unknown, task: () => unknown) => await task(),
};

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
} as const;

export const ProgressLocation = {
  Notification: 15,
} as const;

export const workspace = {
  getConfiguration() {
    return {
      get<T>(_key: string): T | undefined {
        return undefined;
      },
    };
  },
  workspaceFolders: undefined,
  textDocuments: [],
  registerFileSystemProvider(): Disposable {
    return new Disposable(() => {});
  },
  onDidSaveTextDocument(): Disposable {
    return new Disposable(() => {});
  },
  onDidOpenTextDocument(): Disposable {
    return new Disposable(() => {});
  },
  onDidChangeTextDocument(): Disposable {
    return new Disposable(() => {});
  },
  onDidCloseTextDocument(): Disposable {
    return new Disposable(() => {});
  },
  onDidDeleteFiles(): Disposable {
    return new Disposable(() => {});
  },
  openTextDocument: async () => ({}),
};

export const commands = {
  registerCommand(): Disposable {
    return new Disposable(() => {});
  },
  executeCommand: async () => undefined,
};

export const languages = {
  registerCompletionItemProvider(): Disposable {
    return new Disposable(() => {});
  },
  registerCodeActionsProvider(): Disposable {
    return new Disposable(() => {});
  },
  createDiagnosticCollection(_name?: string) {
    const map = new Map<string, Diagnostic[]>();
    return {
      set(uri: Uri, diags: Diagnostic[]): void {
        map.set(uri.toString(), diags);
      },
      delete(uri: Uri): void {
        map.delete(uri.toString());
      },
      clear(): void {
        map.clear();
      },
      dispose(): void {
        map.clear();
      },
    };
  },
};
