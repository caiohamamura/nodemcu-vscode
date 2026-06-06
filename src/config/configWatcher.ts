import * as fs from "node:fs";
import { loadConfig, type NodemcuConfig } from "./nodemcuIni";

export class ConfigWatcher {
  private watcher?: fs.FSWatcher;
  private debounceMs = 200;
  private timer?: NodeJS.Timeout;
  private currentConfig: NodemcuConfig | null = null;
  private listeners: Array<(c: NodemcuConfig) => void> = [];

  constructor(private iniPath: string) {}

  start(): void {
    this.stop();
    this.reload();
    this.watcher = fs.watch(this.iniPath, () => this.scheduleReload());
    this.watcher.on("error", () => this.stop());
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  current(): NodemcuConfig | null {
    return this.currentConfig;
  }

  onChange(listener: (c: NodemcuConfig) => void): void {
    this.listeners.push(listener);
  }

  private scheduleReload(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reload(), this.debounceMs);
  }

  private reload(): void {
    try {
      const c = loadConfig(this.iniPath);
      this.currentConfig = c;
      for (const l of this.listeners) l(c);
    } catch {
      // ignore parse errors; user will see them when opening the file
    }
  }
}
