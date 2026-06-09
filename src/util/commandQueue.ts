import { EventEmitter } from "node:events";

export interface QueuedCommandInfo {
  name: string;
  position: number;
}

export interface RunningCommandInfo {
  name: string;
  startedAt: number;
}

export interface CommandQueueState {
  running: RunningCommandInfo | null;
  pending: QueuedCommandInfo[];
}

interface PendingEntry {
  name: string;
  task: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface RunningEntry {
  name: string;
  controller: AbortController;
  startedAt: number;
}

export class CommandQueue extends EventEmitter {
  private running: RunningEntry | null = null;
  private pending: PendingEntry[] = [];

  enqueue<T>(name: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        name,
        task: task as (signal: AbortSignal) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.emit("change", this.getState());
      this.drain();
    });
  }

  cancelPending(): void {
    const cancelled = this.pending.splice(0);
    for (const entry of cancelled) {
      entry.reject(new Error(`Queued command cancelled: ${entry.name}`));
    }
    if (cancelled.length > 0) {
      this.emit("change", this.getState());
    }
  }

  cancelRunning(): void {
    if (this.running) {
      this.running.controller.abort();
    }
  }

  cancelAll(): void {
    this.cancelPending();
    this.cancelRunning();
  }

  getState(): CommandQueueState {
    return {
      running: this.running ? { name: this.running.name, startedAt: this.running.startedAt } : null,
      pending: this.pending.map((e, i) => ({ name: e.name, position: i + 1 })),
    };
  }

  private drain(): void {
    if (this.running || this.pending.length === 0) return;

    const entry = this.pending.shift()!;
    const controller = new AbortController();
    this.running = { name: entry.name, controller, startedAt: Date.now() };
    this.emit("change", this.getState());

    void entry
      .task(controller.signal)
      .then(
        (value) => entry.resolve(value),
        (err) => entry.reject(err),
      )
      .finally(() => {
        this.running = null;
        this.emit("change", this.getState());
        this.drain();
      });
  }
}
