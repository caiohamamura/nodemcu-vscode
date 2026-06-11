import { describe, expect, it } from "vitest";
import { SerialRingBuffer, type SerialChunk } from "../../src/serial/serialBuffer";
import { SerialCursor } from "../../src/serial/serialCursor";

function chunk(seq: number, text: string): SerialChunk {
  return {
    seq,
    timestamp: Date.now(),
    data: Buffer.from(text, "utf-8"),
    text,
  };
}

describe("SerialCursor", () => {
  it("starts from the latest sequence by default", () => {
    const buffer = new SerialRingBuffer();
    buffer.append(chunk(1, "old"));

    const cursor = new SerialCursor(buffer);
    buffer.append(chunk(2, "new"));

    expect(cursor.readAvailable()).toBe("new");
    expect(cursor.readAvailable()).toBe("");
  });

  it("can include history from the beginning", () => {
    const buffer = new SerialRingBuffer();
    buffer.append(chunk(1, "boot\r\n"));

    const cursor = new SerialCursor(buffer, { includeHistory: true });

    expect(cursor.readAvailable()).toBe("boot\r\n");
  });

  it("waits for a regex across chunks and advances to the matching chunk", async () => {
    const buffer = new SerialRingBuffer();
    const cursor = new SerialCursor(buffer);

    const wait = cursor.waitFor(/>\s*$/m, { timeoutMs: 100 });
    buffer.append(chunk(1, "NodeMCU\r\n"));
    buffer.append(chunk(2, "> "));

    await expect(wait).resolves.toMatchObject({
      text: "NodeMCU\r\n> ",
      fromSeq: 0,
      toSeq: 2,
    });
    expect(cursor.readAvailable()).toBe("");
  });

  it("waits for a string pattern", async () => {
    const buffer = new SerialRingBuffer();
    const cursor = new SerialCursor(buffer);

    const wait = cursor.waitFor("__VSCODE_END__", { timeoutMs: 100 });
    buffer.append(chunk(1, "__VSCODE_BEGIN__OK"));
    buffer.append(chunk(2, "__VSCODE_END__\r\n>"));

    const result = await wait;
    expect(result.match).toBeNull();
    expect(result.toSeq).toBe(2);
  });

  it("waits for any pattern and returns the earliest match", async () => {
    const buffer = new SerialRingBuffer();
    const cursor = new SerialCursor(buffer);

    const wait = cursor.waitForAny([/PANIC/i, "OK"], { timeoutMs: 100 });
    buffer.append(chunk(1, "OK then PANIC"));

    const result = await wait;
    expect(result.match).toBeNull();
    expect(result.text).toBe("OK then PANIC");
    expect(result.toSeq).toBe(1);
  });

  it("ignores old matches unless history is requested", async () => {
    const buffer = new SerialRingBuffer();
    buffer.append(chunk(1, "> "));

    const cursor = new SerialCursor(buffer);
    await expect(cursor.waitFor(/>\s*$/, { timeoutMs: 10 })).rejects.toThrow(/Timed out/);

    await expect(cursor.waitFor(/>\s*$/, { timeoutMs: 10, includeHistory: true })).resolves.toMatchObject({
      fromSeq: 0,
      toSeq: 1,
    });
  });

  it("times out when no pattern is observed", async () => {
    const buffer = new SerialRingBuffer();
    const cursor = new SerialCursor(buffer);

    await expect(cursor.waitFor("missing", { timeoutMs: 10 })).rejects.toThrow(/Timed out/);
  });

  it("supports cancellation", async () => {
    const buffer = new SerialRingBuffer();
    const cursor = new SerialCursor(buffer);
    const controller = new AbortController();

    const wait = cursor.waitFor("ready", { timeoutMs: 1_000, signal: controller.signal });
    controller.abort();

    await expect(wait).rejects.toThrow("Operation cancelled");
  });

  it("readAvailable advances independently for each cursor", () => {
    const buffer = new SerialRingBuffer();
    const first = new SerialCursor(buffer);
    const second = new SerialCursor(buffer);

    buffer.append(chunk(1, "abc"));

    expect(first.readAvailable()).toBe("abc");
    expect(first.readAvailable()).toBe("");
    expect(second.readAvailable()).toBe("abc");
  });

  it("rejects empty pattern sets", async () => {
    const buffer = new SerialRingBuffer();
    const cursor = new SerialCursor(buffer);

    await expect(cursor.waitForAny([], { timeoutMs: 10 })).rejects.toThrow(/At least one/);
  });
});
