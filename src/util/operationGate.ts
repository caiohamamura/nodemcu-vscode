export interface OperationHooks {
  onInterrupt: (previousName: string) => Promise<void>;
}

export interface OperationGateOptions {
  interruptTimeoutMs?: number;
}

interface ActiveOperation {
  name: string;
  controller: AbortController;
  done: Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OperationGate {
  private active: ActiveOperation | null = null;

  constructor(private hooks: OperationHooks, private options: OperationGateOptions = {}) {}

  run<T>(name: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active) {
      this.active.controller.abort();
    }
    return this.start(name, task);
  }

  private async start<T>(name: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = this.active;
    if (previous) {
      const timeoutMs = this.options.interruptTimeoutMs ?? 3000;
      await Promise.race([
        this.hooks.onInterrupt(previous.name),
        delay(timeoutMs),
      ]).catch(() => undefined);
      await Promise.race([
        previous.done,
        delay(timeoutMs),
      ]).catch(() => undefined);
    }

    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const current: ActiveOperation = { name, controller, done };
    this.active = current;

    try {
      return await task(controller.signal);
    } finally {
      if (this.active === current) {
        this.active = null;
      }
      resolveDone();
    }
  }
}
