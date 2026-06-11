import { SerialRingBuffer, type SerialChunk } from "./serialBuffer";

export interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  includeHistory?: boolean;
}

export interface SerialMatch {
  text: string;
  match: RegExpMatchArray | null;
  fromSeq: number;
  toSeq: number;
}

interface LocatedMatch {
  index: number;
  length: number;
  match: RegExpMatchArray | null;
}

export class SerialCursor {
  private position: number;

  constructor(
    private readonly buffer: SerialRingBuffer,
    options: { includeHistory?: boolean } = {},
  ) {
    this.position = options.includeHistory ? 0 : buffer.latestSeq();
  }

  latestSeq(): number {
    return this.position;
  }

  readAvailable(): string {
    const text = this.buffer.textSince(this.position);
    this.position = this.buffer.latestSeq();
    return text;
  }

  waitFor(pattern: RegExp | string, options: WaitOptions): Promise<SerialMatch> {
    return this.waitForAny([pattern], options);
  }

  async waitForAny(patterns: Array<RegExp | string>, options: WaitOptions): Promise<SerialMatch> {
    if (patterns.length === 0) {
      throw new Error("At least one serial pattern is required");
    }

    const deadline = Date.now() + options.timeoutMs;
    const searchFromSeq = options.includeHistory ? 0 : this.position;

    while (true) {
      throwIfAborted(options.signal);

      const found = this.findMatch(patterns, searchFromSeq);
      if (found) {
        this.position = found.toSeq;
        return found;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`Timed out waiting for serial pattern: ${patterns.map(patternLabel).join(", ")}`);
      }

      await this.waitForAppend(remainingMs, options.signal);
    }
  }

  private findMatch(patterns: Array<RegExp | string>, fromSeq: number): SerialMatch | null {
    const chunks = this.buffer.snapshot(fromSeq);
    if (chunks.length === 0) return null;

    const text = chunks.map((chunk) => chunk.text).join("");
    const located = findEarliest(text, patterns);
    if (!located) return null;

    const toSeq = seqAtTextOffset(chunks, located.index + located.length);
    const matchText = text.slice(0, offsetAfterSeq(chunks, toSeq));

    return {
      text: matchText,
      match: located.match,
      fromSeq,
      toSeq,
    };
  }

  private waitForAppend(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;

      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        signal?.removeEventListener("abort", onAbort);
      };

      const onAppend = (): void => {
        cleanup();
        resolve();
      };

      const onAbort = (): void => {
        cleanup();
        reject(new Error("Operation cancelled"));
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      unsubscribe = this.buffer.onAppend(onAppend);

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation cancelled");
  }
}

function findEarliest(text: string, patterns: Array<RegExp | string>): LocatedMatch | null {
  let best: LocatedMatch | null = null;

  for (const pattern of patterns) {
    const located = findPattern(text, pattern);
    if (!located) continue;
    if (!best || located.index < best.index) {
      best = located;
    }
  }

  return best;
}

function findPattern(text: string, pattern: RegExp | string): LocatedMatch | null {
  if (typeof pattern === "string") {
    const index = text.indexOf(pattern);
    return index >= 0 ? { index, length: pattern.length, match: null } : null;
  }

  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  if (!match || match.index === undefined) return null;
  return {
    index: match.index,
    length: match[0].length,
    match,
  };
}

function seqAtTextOffset(chunks: SerialChunk[], offset: number): number {
  let consumed = 0;
  for (const chunk of chunks) {
    consumed += chunk.text.length;
    if (offset <= consumed) return chunk.seq;
  }
  return chunks.at(-1)?.seq ?? 0;
}

function offsetAfterSeq(chunks: SerialChunk[], seq: number): number {
  let offset = 0;
  for (const chunk of chunks) {
    offset += chunk.text.length;
    if (chunk.seq === seq) return offset;
  }
  return offset;
}

function patternLabel(pattern: RegExp | string): string {
  return typeof pattern === "string" ? JSON.stringify(pattern) : pattern.toString();
}
