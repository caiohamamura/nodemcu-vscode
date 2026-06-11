import { describe, expect, it } from "vitest";
import { SerialRingBuffer, type SerialChunk } from "../../src/serial/serialBuffer";

function chunk(seq: number, text: string, timestamp = 1_000): SerialChunk {
  return {
    seq,
    timestamp,
    data: Buffer.from(text, "utf-8"),
    text,
  };
}

describe("SerialRingBuffer", () => {
  it("appends chunks and returns snapshots after a sequence", () => {
    const buffer = new SerialRingBuffer();

    buffer.append(chunk(1, "Node"));
    buffer.append(chunk(2, "MCU"));

    expect(buffer.latestSeq()).toBe(2);
    expect(buffer.snapshot().map((item) => item.text)).toEqual(["Node", "MCU"]);
    expect(buffer.snapshot(1).map((item) => item.text)).toEqual(["MCU"]);
  });

  it("returns text since a sequence", () => {
    const buffer = new SerialRingBuffer();

    buffer.append(chunk(1, "boot\r\n"));
    buffer.append(chunk(2, "> "));

    expect(buffer.textSince(0)).toBe("boot\r\n> ");
    expect(buffer.textSince(1)).toBe("> ");
  });

  it("copies snapshot buffers so callers cannot mutate stored data", () => {
    const buffer = new SerialRingBuffer();
    buffer.append(chunk(1, "abc"));

    const snapshot = buffer.snapshot();
    snapshot[0].data.write("z");

    expect(buffer.snapshot()[0].data.toString("utf-8")).toBe("abc");
  });

  it("rejects non-increasing sequence numbers", () => {
    const buffer = new SerialRingBuffer();

    buffer.append(chunk(2, "first"));

    expect(() => buffer.append(chunk(2, "again"))).toThrow(/sequence must increase/);
    expect(() => buffer.append(chunk(1, "older"))).toThrow(/sequence must increase/);
  });

  it("trims old chunks by byte limit while keeping the newest chunk", () => {
    const buffer = new SerialRingBuffer({ maxBytes: 5 });

    buffer.append(chunk(1, "abc"));
    buffer.append(chunk(2, "def"));
    buffer.append(chunk(3, "gh"));

    expect(buffer.snapshot().map((item) => item.text)).toEqual(["def", "gh"]);
    expect(buffer.textSince(0)).toBe("defgh");
  });

  it("trims old chunks by age", () => {
    const now = Date.now();
    const buffer = new SerialRingBuffer({ maxAgeMs: 100 });

    buffer.append(chunk(1, "old", now - 200));
    buffer.append(chunk(2, "new", now));

    expect(buffer.snapshot().map((item) => item.text)).toEqual(["new"]);
  });

  it("clears buffered chunks", () => {
    const buffer = new SerialRingBuffer();

    buffer.append(chunk(1, "abc"));
    buffer.clear();

    expect(buffer.latestSeq()).toBe(0);
    expect(buffer.snapshot()).toEqual([]);
    expect(buffer.textSince(0)).toBe("");
  });

  it("notifies append listeners and supports unsubscribe", () => {
    const buffer = new SerialRingBuffer();
    const seen: string[] = [];
    const unsubscribe = buffer.onAppend((item) => seen.push(item.text));

    buffer.append(chunk(1, "a"));
    unsubscribe();
    buffer.append(chunk(2, "b"));

    expect(seen).toEqual(["a"]);
  });
});
