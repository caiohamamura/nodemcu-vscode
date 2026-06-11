export interface SerialChunk {
  seq: number;
  timestamp: number;
  data: Buffer;
  text: string;
}

export interface SerialRingBufferOptions {
  maxBytes?: number;
  maxAgeMs?: number;
}

type SerialBufferListener = (chunk: SerialChunk) => void;

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class SerialRingBuffer {
  private chunks: SerialChunk[] = [];
  private totalBytes = 0;
  private listeners = new Set<SerialBufferListener>();

  constructor(private readonly options: SerialRingBufferOptions = {}) {}

  append(chunk: SerialChunk): void {
    const latest = this.latestSeq();
    if (chunk.seq <= latest) {
      throw new Error(`Serial chunk sequence must increase: ${chunk.seq} <= ${latest}`);
    }

    const stored: SerialChunk = {
      seq: chunk.seq,
      timestamp: chunk.timestamp,
      data: Buffer.from(chunk.data),
      text: chunk.text,
    };

    this.chunks.push(stored);
    this.totalBytes += stored.data.byteLength;
    this.trim();

    for (const listener of this.listeners) {
      listener(stored);
    }
  }

  snapshot(fromSeq = 0): SerialChunk[] {
    return this.chunks
      .filter((chunk) => chunk.seq > fromSeq)
      .map((chunk) => ({
        seq: chunk.seq,
        timestamp: chunk.timestamp,
        data: Buffer.from(chunk.data),
        text: chunk.text,
      }));
  }

  textSince(fromSeq: number): string {
    return this.chunks
      .filter((chunk) => chunk.seq > fromSeq)
      .map((chunk) => chunk.text)
      .join("");
  }

  latestSeq(): number {
    return this.chunks.at(-1)?.seq ?? 0;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }

  onAppend(listener: SerialBufferListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private trim(): void {
    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    while (this.chunks.length > 1 && this.totalBytes > maxBytes) {
      const removed = this.chunks.shift()!;
      this.totalBytes -= removed.data.byteLength;
    }

    const maxAgeMs = this.options.maxAgeMs;
    if (maxAgeMs === undefined) return;

    const cutoff = Date.now() - maxAgeMs;
    while (this.chunks.length > 1 && this.chunks[0].timestamp < cutoff) {
      const removed = this.chunks.shift()!;
      this.totalBytes -= removed.data.byteLength;
    }
  }
}
