import * as vscode from "vscode";
import { SerialSession } from "./serialSession";

export class SerialSessionManager implements vscode.Disposable {
  private currentSession: SerialSession | undefined;
  private readonly onDidChangeSessionEmitter = new vscode.EventEmitter<SerialSession | undefined>();

  readonly onDidChangeSession = this.onDidChangeSessionEmitter.event;

  dispose(): void {
    void this.closeAll();
    this.onDidChangeSessionEmitter.dispose();
  }

  getSession(port: string, baud: number): SerialSession {
    if (this.currentSession && this.currentSession.port === port && this.currentSession.baudRate === baud) {
      return this.currentSession;
    }
    if (this.currentSession) {
      void this.currentSession.close();
      this.currentSession.dispose();
    }
    this.currentSession = new SerialSession(port, baud);
    this.onDidChangeSessionEmitter.fire(this.currentSession);
    return this.currentSession;
  }

  getCurrentSession(): SerialSession | undefined {
    return this.currentSession;
  }

  async switchPort(port: string, baud: number): Promise<SerialSession> {
    const session = this.getSession(port, baud);
    await session.open();
    return session;
  }

  async closeAll(): Promise<void> {
    const session = this.currentSession;
    this.currentSession = undefined;
    this.onDidChangeSessionEmitter.fire(undefined);
    if (session) {
      await session.close();
      session.dispose();
    }
  }

  async withPortReleased<T>(port: string, fn: () => Promise<T>): Promise<T> {
    const session = this.currentSession;
    const shouldReopen = !!session && session.port === port;
    if (!shouldReopen || !session) {
      return await fn();
    }

    session.markReleasedForFlash();
    await session.close();
    try {
      return await fn();
    } finally {
      try {
        await withTimeout(session.open(), 5_000, `Timed out reopening serial session on ${port}`);
      } catch {
        this.currentSession = undefined;
        this.onDidChangeSessionEmitter.fire(undefined);
        session.dispose();
      }
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
