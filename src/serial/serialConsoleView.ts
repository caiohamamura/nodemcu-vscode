import * as vscode from "vscode";
import { SerialDeviceClient } from "../device/serialDeviceClient";
import { SerialSessionManager } from "./serialSessionManager";
import { type SerialChunk } from "./serialBuffer";
import { type SerialSession } from "./serialSession";

interface SerialConsoleViewOptions {
  ensureSession: () => Promise<SerialSession | undefined>;
  log: (message: string) => void;
}

export class SerialConsoleViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private sessionDisposable: vscode.Disposable | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    _extensionUri: vscode.Uri,
    private readonly sessionManager: SerialSessionManager,
    private readonly options: SerialConsoleViewOptions,
  ) {
    this.disposables.push(
      this.sessionManager.onDidChangeSession((session) => {
        void this.bindSession(session);
      }),
    );
  }

  dispose(): void {
    this.sessionDisposable?.dispose();
    this.sessionDisposable = undefined;
    this.view = undefined;
    vscode.Disposable.from(...this.disposables).dispose();
  }

  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    await vscode.commands.executeCommand("workbench.view.extension.nodemcu-serial-panel");
    await vscode.commands.executeCommand("nodemcu.serialConsole.focus");
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.sessionDisposable?.dispose();
      this.sessionDisposable = undefined;
    });
    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.type === "clear") {
          this.post({ type: "clear" });
          return;
        }

        const session = await this.options.ensureSession();
        if (!session) {
          return;
        }

        switch (message.type) {
          case "send": {
            if (!isConsoleInputState(session.getState())) {
              this.post({
                type: "session",
                port: session.port,
                baudRate: session.baudRate,
                state: session.getState(),
              });
              return;
            }
            const text = String(message.text ?? "");
            if (!text.trim()) {
              return;
            }
            await session.runExclusive("Console Input", async () => {
              await session.write(text.endsWith("\n") ? text : `${text}\r\n`);
            });
            return;
          }
          case "reset": {
            const client = new SerialDeviceClient(session);
            const result = await client.reset();
            if (!result.success) {
              this.options.log(`Serial reset failed: ${result.error}`);
              void vscode.window.showErrorMessage(`Serial reset failed: ${result.error}`);
            }
            return;
          }
          default:
            return;
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        this.options.log(`Serial console action failed: ${messageText}`);
        void vscode.window.showErrorMessage(`NodeMCU serial console failed: ${messageText}`);
      }
    });

    void this.bindSession(this.sessionManager.getCurrentSession());
  }

  private async bindSession(session: SerialSession | undefined): Promise<void> {
    this.sessionDisposable?.dispose();
    this.sessionDisposable = undefined;

    if (!this.view) {
      return;
    }

    this.post({
      type: "session",
      port: session?.port ?? "",
      baudRate: session?.baudRate ?? 0,
      state: session?.getState() ?? "closed",
    });

    if (!session) {
      this.post({ type: "clear" });
      return;
    }

    for (const chunk of session.snapshot()) {
      this.postChunk(chunk);
    }

    this.sessionDisposable = vscode.Disposable.from(
      session.onData((chunk) => this.postChunk(chunk)),
      session.onStateChanged((state) => {
        this.post({
          type: "session",
          port: session.port,
          baudRate: session.baudRate,
          state,
        });
      }),
    );
  }

  private postChunk(chunk: SerialChunk): void {
    this.post({
      type: "serialData",
      seq: chunk.seq,
      text: chunk.text,
      timestamp: chunk.timestamp,
    });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
    }

    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--bg);
      color: var(--fg);
      font: 12px/1.45 var(--vscode-font-family);
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
    }

    .status {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .status strong {
      font-size: 12px;
      font-weight: 600;
    }

    .status span {
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .controls label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--muted);
      white-space: nowrap;
    }

    .output {
      flex: 1;
      overflow: auto;
      padding: 10px;
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.5 Consolas, "Courier New", monospace;
    }

    .inputRow {
      display: grid;
      grid-template-columns: 1fr auto auto auto;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 88%, black 12%);
    }

    textarea {
      min-height: 44px;
      max-height: 140px;
      resize: vertical;
      border: 1px solid var(--border);
      background: var(--input-bg);
      color: var(--input-fg);
      padding: 10px 12px;
      border-radius: 4px;
      font: 12px/1.4 Consolas, "Courier New", monospace;
    }

    textarea:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }

    button {
      border: 0;
      border-radius: 4px;
      background: var(--button-bg);
      color: var(--button-fg);
      padding: 0 12px;
      min-width: 72px;
      cursor: pointer;
    }

    button:hover {
      background: var(--button-hover);
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    button:disabled:hover {
      background: var(--button-bg);
    }

    .secondary {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="status">
      <strong id="portLabel">Serial Console</strong>
      <span id="stateLabel">Disconnected</span>
    </div>
    <div class="controls">
      <label><input type="checkbox" id="pauseToggle" /> Pause</label>
      <label><input type="checkbox" id="autoscrollToggle" checked /> Auto-scroll</label>
      <label><input type="checkbox" id="localEchoToggle" checked /> Local echo</label>
      <label><input type="checkbox" id="timestampToggle" /> Timestamps</label>
      <button class="secondary" id="clearButton" type="button">Clear</button>
      <button class="secondary" id="resetButton" type="button">Reset</button>
    </div>
  </div>
  <div class="output" id="output"></div>
  <div class="inputRow">
    <textarea id="input" placeholder="print(node.heap())"></textarea>
    <button id="sendButton" type="button">Send</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const output = document.getElementById("output");
    const input = document.getElementById("input");
    const sendButton = document.getElementById("sendButton");
    const resetButton = document.getElementById("resetButton");
    const clearButton = document.getElementById("clearButton");
    const pauseToggle = document.getElementById("pauseToggle");
    const autoscrollToggle = document.getElementById("autoscrollToggle");
    const localEchoToggle = document.getElementById("localEchoToggle");
    const timestampToggle = document.getElementById("timestampToggle");
    const portLabel = document.getElementById("portLabel");
    const stateLabel = document.getElementById("stateLabel");

    function canSendForState(state, hasPort) {
      return hasPort && (state === "open" || state === "ready");
    }

    // Disabling a focused element drops its focus, and re-enabling does not
    // restore it. Sending a command briefly disables the input (busy state)
    // and re-enables it once ready, which loses focus across the two updates.
    // Track the focus intent so we can restore it when the input comes back.
    let keepInputFocused = false;

    function updateInputState(state, hasPort) {
      const canSend = canSendForState(state, hasPort);
      // Capture focus before toggling "disabled", which would blur the element.
      if (document.activeElement === input) {
        keepInputFocused = true;
      }
      input.disabled = !canSend;
      sendButton.disabled = !canSend;
      resetButton.disabled = !hasPort || state === "busy" || state === "opening" || state === "booting" || state === "released-for-flash";
      input.placeholder = canSend ? "print(node.heap())" : "Serial operation in progress";
      if (canSend && keepInputFocused && document.activeElement !== input) {
        input.focus();
        keepInputFocused = false;
      }
    }

    function appendText(text, timestamp) {
      const prefix = timestampToggle.checked && typeof timestamp === "number"
        ? "[" + new Date(timestamp).toLocaleTimeString() + "] "
        : "";
      output.textContent += prefix + text;
      if (autoscrollToggle.checked) {
        output.scrollTop = output.scrollHeight;
      }
    }

    function sendInput() {
      if (input.disabled || sendButton.disabled) {
        return;
      }
      const text = input.value;
      if (!text.trim()) {
        return;
      }
      if (localEchoToggle.checked) {
        appendText("> " + text + "\\n", Date.now());
      }
      vscode.postMessage({ type: "send", text });
      input.value = "";
      input.focus();
    }

    sendButton.addEventListener("click", sendInput);
    resetButton.addEventListener("click", () => vscode.postMessage({ type: "reset" }));
    clearButton.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendInput();
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      switch (message.type) {
        case "serialData":
          if (!pauseToggle.checked) {
            appendText(message.text, message.timestamp);
          }
          break;
        case "clear":
          output.textContent = "";
          break;
        case "session":
          portLabel.textContent = message.port ? "Serial Console " + message.port : "Serial Console";
          stateLabel.textContent = message.port
            ? message.port + " @ " + message.baudRate + " baud - " + message.state
            : "Disconnected";
          updateInputState(message.state, Boolean(message.port));
          break;
      }
    });

    updateInputState("closed", false);
  </script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let index = 0; index < 24; index += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

function isConsoleInputState(state: string): boolean {
  return state === "open" || state === "ready";
}
